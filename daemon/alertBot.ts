/**
 * Background Alert Bot — live Gold / Silver / Bitcoin signals.
 * - Local: npm run alerts (Windows toast + optional Telegram)
 * - Railway: started from prodServer when Telegram env is set (or ENABLE_ALERT_WORKER=1)
 */
import { ASSETS } from "../src/config/assets";
import { fetchLiveQuote } from "../src/services/liveQuotes";
import { fetchMultiTimeframe } from "../src/services/marketData";
import { computeRegime, generateSignal } from "../src/strategies/signalEngine";
import { computeNowAction } from "../src/utils/nowAction";
import { roundPrice } from "../src/strategies/indicators";
import type { AssetId, RegimeTag, TradeMode } from "../src/types";
import {
  loadDaemonState,
  saveDaemonState,
  planKey,
  type DaemonState,
} from "./planStore";
import { planFromOpenSignal } from "./resumeOpenPlan";
import {
  createFrozenPlan,
  shouldKeepFrozenPlan,
  REGIME_FLIP_NOTE,
  type FrozenPlan,
} from "../src/services/tradePlan";
import { buildSessionExtras, canAutoLockPlan } from "../src/utils/sessionPlan";
import { logSignalFromLive } from "../src/calibration";
import {
  resolveOpenSignalsForSymbol,
  resolveRegimeFlipShadows,
  invalidateLoggedPlan,
  invalidateLoggedPlanRegimeFlip,
  markLiquiditySweep,
  markTrendConfirmed,
  setTrendDuration,
  listOpenSignals,
} from "../src/calibration/resolveOutcomes";
import { isLiquiditySweepAgainst } from "../src/utils/liquidityWarning";
import {
  evaluateTrendConfirm,
  markTrendConsumed,
  newTrendTracker,
  type TrendTracker,
} from "../src/utils/trendConfirm";
import { makePlanKey } from "../src/calibration/signalStore";
import {
  alertChannelsStatus,
  assetLabel,
  dispatchTradeAlert,
  isTelegramConfigured,
} from "../src/services/notify";

const TICK_MS = Number(process.env.ALERT_TICK_MS) || 2500;
const SIGNAL_EVERY_N = 8;

let tickCount = 0;
let workerRunning = false;
/** In-process SoT while the worker loop is alive (same object tick() mutates). */
let liveState: DaemonState | null = null;

// SCALPING-ONLY trend-confirmation state (keyed by daemon planKey assetId-mode).
// Intraday keys are never inserted here.
const trendTrackers = new Map<string, TrendTracker>();
const trendRuns = new Map<
  string,
  { dir: "BUY" | "SELL"; dbKey: string; bars: number; lastBarTime: number }
>();

function getTrendTracker(key: string): TrendTracker {
  let t = trendTrackers.get(key);
  if (!t) {
    t = newTrendTracker();
    trendTrackers.set(key, t);
  }
  return t;
}

function log(...args: unknown[]) {
  console.log(`[alertBot ${new Date().toLocaleTimeString()}]`, ...args);
}

function lockPlan(
  state: DaemonState,
  assetId: AssetId,
  mode: TradeMode,
  signal: ReturnType<typeof generateSignal>,
  live: number,
  htfRegimes: (RegimeTag | null | undefined)[],
  trendConfirmed = false,
) {
  const key = planKey(assetId, mode);
  let current = state.plans[key] ?? null;

  if (current && current.status !== "INVALIDATED") {
    const entry = current.levels.entry;
    const sl = current.levels.stopLoss;
    const risk = Math.abs(sl - entry);
    if (current.side === "SELL" && live > entry + risk * 0.5) {
      current = {
        ...current,
        status: "INVALIDATED",
        note: "Missed entry / ran into SL zone — refreshing plan",
      };
      state.plans[key] = current;
    } else if (current.side === "BUY" && live < entry - risk * 0.5) {
      current = {
        ...current,
        status: "INVALIDATED",
        note: "Missed entry / ran into SL zone — refreshing plan",
      };
      state.plans[key] = current;
    }
  }

  if (
    current &&
    current.status !== "INVALIDATED" &&
    current.assetId === assetId &&
    current.mode === mode
  ) {
    const kept = shouldKeepFrozenPlan(
      current,
      signal.side,
      live,
      signal.diagnostics.regime,
      htfRegimes,
    );
    // Regime flip: log REGIME_FLIP_INVALIDATED, clear plan, allow immediate re-lock
    if (kept && kept.status === "INVALIDATED" && kept.note === REGIME_FLIP_NOTE) {
      invalidateLoggedPlanRegimeFlip(
        makePlanKey(
          assetId,
          mode,
          current.side,
          current.levels.entry,
          current.levels.stopLoss,
          current.levels.takeProfit1,
        ),
      );
      state.plans[key] = null;
      // fall through to canAutoLockPlan for immediate fresh evaluation
    } else {
      state.plans[key] = kept;
      return state.plans[key];
    }
  }

  const currentForLock = state.plans[key] ?? null;
  if (canAutoLockPlan(mode, signal, currentForLock, assetId)) {
    const extras = buildSessionExtras(
      assetId,
      mode,
      signal.side,
      signal.levels!,
      signal,
    );
    const created = createFrozenPlan(
      assetId,
      mode,
      signal.side,
      signal.levels!,
      signal.confidence,
      signal.rangePrediction.winProbability,
      extras,
    );
    // SCALPING-ONLY: tag the fresh lock as trend-confirmed (drives distinct alert).
    if (trendConfirmed && created.status !== "INVALIDATED" && mode === "scalping") {
      created.trendConfirmed = true;
      created.trendConfirmedAt = Date.now();
    }
    state.plans[key] = created.status === "INVALIDATED" ? null : created;
    return state.plans[key];
  }

  if (current?.status === "INVALIDATED" && mode === "scalping") {
    state.plans[key] = null;
  }

  return state.plans[key] ?? null;
}

async function checkOne(state: DaemonState, assetId: AssetId, mode: TradeMode) {
  const asset = ASSETS[assetId];
  const quote = await fetchLiveQuote(assetId);
  const live = quote.price;
  const frames = await fetchMultiTimeframe(assetId, mode, live);
  const signal = generateSignal(assetId, mode, frames);
  signal.price = roundPrice(live, asset.decimals);

  // HTF regimes (same computeRegime/deriveRegimeTag on the higher-TF series) —
  // gate 2 of regime-flip invalidation: at least one HTF must also oppose.
  const htfRegimes: (RegimeTag | null | undefined)[] = [
    frames.confirmation.length ? computeRegime(frames.confirmation) : null,
    frames.bias.length ? computeRegime(frames.bias) : null,
  ];

  // ── SCALPING-ONLY: trend-confirmation early trigger + trend-duration tracking.
  // Intraday never enters this branch, so its session-lock path is untouched.
  const dkey = planKey(assetId, mode);
  let trendConfirmedNow = false;
  const primaryBarTime = frames.primary.length
    ? frames.primary[frames.primary.length - 1].time
    : Date.now();
  if (mode === "scalping") {
    const tracker = getTrendTracker(dkey);
    const res = evaluateTrendConfirm(
      tracker,
      signal.diagnostics.regime,
      frames.primary,
      htfRegimes,
      primaryBarTime,
    );
    trendConfirmedNow = res.armed && res.dir === signal.side;

    // Advance / finalize the confirmed-trend duration counter on new closed bars.
    const run = trendRuns.get(dkey);
    if (run && primaryBarTime !== run.lastBarTime) {
      const still =
        (run.dir === "BUY" && signal.diagnostics.regime === "TREND_UP") ||
        (run.dir === "SELL" && signal.diagnostics.regime === "TREND_DOWN");
      if (still) {
        run.bars += 1;
        run.lastBarTime = primaryBarTime;
      } else {
        setTrendDuration(run.dbKey, run.bars);
        trendRuns.delete(dkey);
      }
    }
  }

  let plan = lockPlan(
    state,
    assetId,
    mode,
    signal,
    live,
    htfRegimes,
    trendConfirmedNow,
  );

  // Daemon plan missing after redeploy but History still has OPEN → resume
  if (!plan || plan.status === "INVALIDATED") {
    try {
      const resumed = planFromOpenSignal(assetId, mode);
      if (resumed) {
        state.plans[planKey(assetId, mode)] = resumed;
        plan = resumed;
        log(`checkOne resumed OPEN ${assetId}/${mode} @ ${resumed.levels.entry}`);
      }
    } catch {
      /* ignore */
    }
  }

  // Start a duration run when a fresh trend-confirmed scalping plan just locked.
  if (
    mode === "scalping" &&
    plan?.trendConfirmed &&
    plan.status === "WAITING_ENTRY" &&
    (plan.side === "BUY" || plan.side === "SELL") &&
    !trendRuns.has(dkey)
  ) {
    trendRuns.set(dkey, {
      dir: plan.side,
      dbKey: makePlanKey(
        assetId,
        mode,
        plan.side,
        plan.levels.entry,
        plan.levels.stopLoss,
        plan.levels.takeProfit1,
      ),
      bars: 0,
      lastBarTime: primaryBarTime,
    });
    markTrendConsumed(getTrendTracker(dkey));
  }
  if (plan && plan.status !== "INVALIDATED") {
    signal.side = plan.side;
    signal.levels = plan.levels;

    // Tier-1 early warning (log only, no alert): liquidity sweep vs plan side.
    if (
      (plan.side === "BUY" || plan.side === "SELL") &&
      isLiquiditySweepAgainst(plan.side, frames.primary)
    ) {
      markLiquiditySweep(
        makePlanKey(
          assetId,
          mode,
          plan.side,
          plan.levels.entry,
          plan.levels.stopLoss,
          plan.levels.takeProfit1,
        ),
        Date.now(),
      );
    }
  }

  let now = computeNowAction(signal, plan, live, asset, quote);

  // Promote waiting → active when entry zone is hit (UI ACTIVE TRADE).
  // Keep `now` as ENTER_NOW for this tick so entry alerts still fire once.
  if (plan?.status === "WAITING_ENTRY" && now.action === "ENTER_NOW") {
    plan = {
      ...plan,
      status: "IN_TRADE_HINT",
      note: `Entry hit @ ${plan.levels.entry}. Trade active; manage original SL/TP.`,
    };
    state.plans[planKey(assetId, mode)] = plan;
  }

  if (now.action === "TOO_LATE" || now.action === "PLAN_DEAD") {
    if (plan?.levels && (plan.side === "BUY" || plan.side === "SELL")) {
      invalidateLoggedPlan(
        makePlanKey(
          assetId,
          mode,
          plan.side,
          plan.levels.entry,
          plan.levels.stopLoss,
          plan.levels.takeProfit1,
        ),
        now.action,
      );
    }

    if (mode === "intraday" && plan) {
      const dead = {
        ...plan,
        status: "INVALIDATED" as const,
        note:
          plan.note ||
          "Intraday zone miss/SL — aaj naya auto plan nahi. Kal / New plan.",
      };
      state.plans[planKey(assetId, mode)] = dead;
      now = computeNowAction(signal, dead, live, asset, quote);
      return { signal, plan: dead, now, quote };
    }

    state.plans[planKey(assetId, mode)] = null;
    plan = null;
    const fresh = generateSignal(assetId, mode, frames);
    fresh.price = roundPrice(live, asset.decimals);
    if (canAutoLockPlan(mode, fresh, null, assetId)) {
      const extras = buildSessionExtras(
        assetId,
        mode,
        fresh.side,
        fresh.levels!,
        fresh,
      );
      plan = createFrozenPlan(
        assetId,
        mode,
        fresh.side,
        fresh.levels!,
        fresh.confidence,
        fresh.rangePrediction.winProbability,
        extras,
      );
      if (
        plan.status !== "INVALIDATED" &&
        mode === "scalping" &&
        trendConfirmedNow &&
        fresh.side === signal.side
      ) {
        plan.trendConfirmed = true;
        plan.trendConfirmedAt = Date.now();
      }
      if (plan.status === "INVALIDATED") plan = null;
      state.plans[planKey(assetId, mode)] = plan;
    }
    now = computeNowAction(fresh, plan, live, asset, quote);
    return { signal: fresh, plan, now, quote };
  }

  return { signal, plan, now, quote };
}

async function tick(state: DaemonState) {
  tickCount += 1;
  const verbose = tickCount % SIGNAL_EVERY_N === 1;

  for (const w of state.watches) {
    try {
      const { signal, plan, now, quote } = await checkOne(
        state,
        w.assetId,
        w.mode,
      );
      const name = assetLabel(w.assetId);
      const label = `${name}/${w.mode}`;
      const entry = plan?.levels.entry;
      const d = ASSETS[w.assetId].decimals;

      if (signal.side !== "WAIT" && signal.levels) {
        const toLog =
          plan && plan.status !== "INVALIDATED"
            ? {
                ...signal,
                side: plan.side,
                levels: plan.levels,
              }
            : signal;
        logSignalFromLive(toLog);
      }
      // SCALPING-ONLY: stamp trendConfirmedAt once the row exists in signals.db.
      if (
        w.mode === "scalping" &&
        plan?.trendConfirmed &&
        plan.status === "WAITING_ENTRY" &&
        (plan.side === "BUY" || plan.side === "SELL")
      ) {
        markTrendConfirmed(
          makePlanKey(
            w.assetId,
            w.mode,
            plan.side,
            plan.levels.entry,
            plan.levels.stopLoss,
            plan.levels.takeProfit1,
          ),
          plan.trendConfirmedAt ?? Date.now(),
        );
      }
      const priceCtx = {
        price: quote.price,
        high: quote.high,
        low: quote.low,
        open: quote.price,
      };
      resolveOpenSignalsForSymbol(w.assetId, priceCtx);
      // Informational: fill wouldHaveHitSlFirst on past regime-flip drops
      resolveRegimeFlipShadows(w.assetId, priceCtx);

      if (
        verbose ||
        now.action === "ENTER_NOW" ||
        now.action === "TOO_LATE" ||
        now.action === "WAIT_ENTRY"
      ) {
        log(
          `${label.padEnd(18)} ${now.action.padEnd(12)} live=${quote.price.toFixed(d)} entry=${entry ?? "-"} conf=${signal.confidence}%`,
        );
      }

      // Alert #1: plan / zone locked
      if (plan && plan.status === "WAITING_ENTRY") {
        const lockKey = `LOCK:${w.assetId}:${w.mode}:${plan.lockedAt}`;
        if (!state.lastAlertAt[lockKey]) {
          state.lastAlertAt[lockKey] = Date.now();
          const zone =
            plan.entryZoneLow != null && plan.entryZoneHigh != null
              ? `${plan.entryZoneLow}–${plan.entryZoneHigh}`
              : String(plan.levels.entry);
          const trendAlert = plan.trendConfirmed && plan.mode === "scalping";
          const title = trendAlert
            ? "🔥 NEW TREND STARTING"
            : plan.mode === "intraday"
              ? "ZONE LOCKED"
              : "PLAN LOCKED";
          const body = trendAlert
            ? [
                `🔥 New trend starting — ${plan.side} scalping, SL ${plan.levels.stopLoss} TP1 ${plan.levels.takeProfit1} — chart confirm karke lo.`,
                `Entry zone: ${zone} · TP2 ${plan.levels.takeProfit2}`,
                `Conf ${plan.lockedConfidence ?? signal.confidence}% · Win ${plan.lockedWinProbability ?? signal.rangePrediction.winProbability}%`,
                `Live ${quote.price.toFixed(d)}`,
              ].join("\n")
            : [
                `${plan.side} entry zone: ${zone}`,
                `SL ${plan.levels.stopLoss} · TP1 ${plan.levels.takeProfit1} · TP2 ${plan.levels.takeProfit2}`,
                `Conf ${plan.lockedConfidence ?? signal.confidence}% · Win ${plan.lockedWinProbability ?? signal.rangePrediction.winProbability}%`,
                `Live ${quote.price.toFixed(d)}`,
              ].join("\n");
          log("PLAN LOCK >>>", name, title);
          await dispatchTradeAlert({
            kind: "PLAN_LOCK",
            assetId: w.assetId,
            mode: w.mode,
            side: plan.side,
            title,
            body,
          });
        }
      }

      // Alert #2: entry zone hit
      const highQuality =
        now.action === "ENTER_NOW" &&
        now.inEntryZone &&
        now.entry != null &&
        signal.confidence >= state.minConfidence &&
        signal.rangePrediction.winProbability >= state.minWinProb &&
        Math.abs(quote.price - now.entry) <=
          Math.abs(now.stopLoss! - now.entry) * 0.35;

      if (highQuality) {
        const alertKey = `ENTRY:${w.assetId}:${w.mode}:${now.side}:${now.entry}`;
        const last = state.lastAlertAt[alertKey] ?? 0;
        if (Date.now() - last > 5 * 60 * 1000) {
          state.lastAlertAt[alertKey] = Date.now();
          const title = now.headlineUr || "ENTRY HIT";
          const body = [
            `${now.side} NOW @ ${now.entry}`,
            `Live ${now.livePrice} · SL ${now.stopLoss} · TP1 ${now.takeProfit}`,
            `Conf ${signal.confidence}% · Win ${signal.rangePrediction.winProbability}%`,
            `Mode: ${w.mode}`,
          ].join("\n");
          log("ENTRY >>>", name, title);
          await dispatchTradeAlert({
            kind: "ENTRY_HIT",
            assetId: w.assetId,
            mode: w.mode,
            side: String(now.side),
            title,
            body,
          });
        }
      }
    } catch (e) {
      log(`ERR ${w.assetId}/${w.mode}:`, e instanceof Error ? e.message : e);
    }
  }

  saveDaemonState(state);
}

/**
 * Authoritative locked plan for asset+mode (alertBot lock cycle).
 * Prefers live in-memory state; falls back to persisted daemon state file;
 * then resumes from OPEN calibration row so Scalp UI matches History.
 */
export function getAuthoritativePlan(
  assetId: AssetId,
  mode: TradeMode,
): FrozenPlan | null {
  const state = liveState ?? loadDaemonState();
  const key = planKey(assetId, mode);
  const existing = state.plans[key] ?? null;
  if (existing && existing.status !== "INVALIDATED") return existing;

  try {
    const resumed = planFromOpenSignal(assetId, mode);
    if (resumed) {
      state.plans[key] = resumed;
      saveDaemonState(state);
      liveState = state;
      log(`Resumed OPEN plan ${assetId}/${mode} @ ${resumed.levels.entry}`);
      return resumed;
    }
  } catch (e) {
    log("resume OPEN failed:", e instanceof Error ? e.message : e);
  }
  return existing;
}

/** Clear server lock for this mode (UI "New plan"). Next tick may re-lock. */
export function clearAuthoritativePlan(assetId: AssetId, mode: TradeMode): void {
  const state = liveState ?? loadDaemonState();
  state.plans[planKey(assetId, mode)] = null;
  const lockPrefix = `LOCK:${assetId}:${mode}:`;
  const entryPrefix = `ENTRY:${assetId}:${mode}:`;
  for (const k of Object.keys(state.lastAlertAt)) {
    if (k.startsWith(lockPrefix) || k.startsWith(entryPrefix)) {
      delete state.lastAlertAt[k];
    }
  }
  // Keep History consistent — don't leave an OPEN row that would auto-resume
  try {
    for (const s of listOpenSignals().filter(
      (row) => row.symbol === assetId && row.mode === mode && row.outcome === "OPEN",
    )) {
      invalidateLoggedPlan(s.planKey, "UI New plan — lock cleared");
    }
  } catch {
    /* db may be unavailable */
  }
  saveDaemonState(state);
  if (!liveState) liveState = state;
}

export function isAlertWorkerRunning(): boolean {
  return workerRunning;
}

/** Idempotent — call from plan API so local Vite also has a lock SoT. */
export function ensureAlertWorker(): void {
  startAlertWorker();
}

/** Start background poll loop (idempotent). Used by CLI and Railway prodServer. */
export function startAlertWorker(): void {
  if (workerRunning) {
    log("Worker already running — skip");
    return;
  }
  workerRunning = true;

  const state = loadDaemonState();
  liveState = state;
  // Hydrate missing plans from OPEN History rows before first tick
  for (const w of state.watches) {
    const key = planKey(w.assetId, w.mode);
    const cur = state.plans[key];
    if (cur && cur.status !== "INVALIDATED") continue;
    try {
      const resumed = planFromOpenSignal(w.assetId, w.mode);
      if (resumed) {
        state.plans[key] = resumed;
        log(`boot resume OPEN ${w.assetId}/${w.mode} @ ${resumed.levels.entry}`);
      }
    } catch {
      /* ignore */
    }
  }
  saveDaemonState(state);
  const ch = alertChannelsStatus();

  console.log(`
════════════════════════════════════════════════
  SMC LIVE ALERT WORKER
  Gold · Silver · Bitcoin — tab band bhi alerts
════════════════════════════════════════════════
  Pairs    : ${state.watches.map((w) => `${assetLabel(w.assetId)}/${w.mode}`).join(", ")}
  Gate     : conf>=${state.minConfidence}%  win>=${state.minWinProb}%
  Poll     : every ${TICK_MS}ms
  Telegram : ${ch.telegram ? "ON ✓" : "OFF (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)"}
  Windows  : ${ch.windows ? "ON" : "n/a"}
════════════════════════════════════════════════
`);

  if (!ch.telegram && !ch.windows) {
    log(
      "⚠ No notify channel. Railway pe Telegram zaroor set karo warna alerts sirf logs mein aayenge.",
    );
  }

  void (async () => {
    for (;;) {
      try {
        await tick(state);
      } catch (e) {
        log("tick fatal:", e instanceof Error ? e.message : e);
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  })();
}

export function shouldAutoStartAlertWorker(): boolean {
  const flag = (process.env.ENABLE_ALERT_WORKER ?? "auto").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  // auto: start on Railway / when Telegram or Web Push is configured
  const webPushConfigured = Boolean(
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY && process.env.WEB_PUSH_VAPID_PRIVATE_KEY,
  );
  return isTelegramConfigured() || webPushConfigured || Boolean(process.env.RAILWAY_ENVIRONMENT);
}

/** CLI entry: npm run alerts */
async function main() {
  startAlertWorker();
}

const isDirect =
  process.argv[1]?.includes("alertBot") ||
  process.env.npm_lifecycle_event === "alerts";

if (isDirect) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
