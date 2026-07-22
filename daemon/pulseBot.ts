/**
 * QS Pro (Pulse) bot — SMC + fractal-agree + fast TP1, with TP2 upgrade.
 * Isolated from alertBot / Pro / Quick Scalp.
 *
 * Local: npm run pulse
 * Auto: ENABLE_PULSE_WORKER=1 (or auto on Railway)
 */
import { ASSETS } from "../src/config/assets";
import { fetchMultiTimeframe } from "../src/services/marketData";
import { generatePulseSignal } from "../src/strategies/pulseEngine";
import { dispatchTradeAlert } from "../src/services/notify";
import {
  getLivePulseDb,
  getOpenOrLatestPulse,
  insertPulseRow,
  markPulseExecuted,
  signalToRow,
  updatePulseOutcome,
  type PulseOutcome,
  type PulseRow,
} from "../src/pulse/store";
import type { Candle } from "../src/types";
import {
  isFreshPendingEntryViable,
  pendingEntryState,
} from "../src/history/entryTouch";
import { entryTolerance } from "../src/utils/tradeSafety";

const TICK_MS = Number(process.env.PULSE_TICK_MS) || 15_000;
const ASSET = "XAUUSD" as const;
const COOLDOWN_MS = 45 * 60 * 1000;

let workerRunning = false;
let lastAlertAt = 0;
let openTrade: PulseRow | null = null;

function log(...args: unknown[]) {
  console.log(`[pulse ${new Date().toLocaleTimeString()}]`, ...args);
}

function hitTp2(row: PulseRow, bar: Candle): boolean {
  return row.direction === "BUY"
    ? bar.high >= row.tp2
    : bar.low <= row.tp2;
}

function resolveBar(
  row: PulseRow,
  bar: Candle,
): "TP1_HIT" | "TP2_HIT" | "SL_HIT" | null {
  const buy = row.direction === "BUY";
  const hitSl = buy ? bar.low <= row.sl : bar.high >= row.sl;
  const hitTp1 = buy ? bar.high >= row.tp1 : bar.low <= row.tp1;
  const tp2 = hitTp2(row, bar);
  // Same-bar ambiguity: SL wins ties.
  if (hitSl && (hitTp1 || tp2)) return "SL_HIT";
  if (hitSl) return "SL_HIT";
  if (tp2) return "TP2_HIT";
  if (hitTp1) return "TP1_HIT";
  return null;
}

function realizedRFor(
  row: PulseRow,
  hit: "TP1_HIT" | "TP2_HIT" | "SL_HIT",
): number {
  if (hit === "SL_HIT") return -1;
  const risk = Math.abs(row.entry - row.sl);
  if (risk <= 0) return hit === "TP2_HIT" ? 1.5 : 0.85;
  const target = hit === "TP2_HIT" ? row.tp2 : row.tp1;
  return Math.abs(target - row.entry) / risk;
}

/** If an already-closed TP1 row later reaches TP2, upgrade the outcome. */
function maybeUpgradeTp1ToTp2(db: ReturnType<typeof getLivePulseDb>, bar: Candle) {
  const latest = getOpenOrLatestPulse(db);
  if (!latest || latest.outcome !== "TP1_HIT") return;
  if (!hitTp2(latest, bar)) return;
  updatePulseOutcome(
    db,
    latest.id,
    "TP2_HIT",
    realizedRFor(latest, "TP2_HIT"),
    Date.now(),
  );
  log("upgraded", latest.direction, "TP1_HIT → TP2_HIT @", latest.tp2);
}

async function tick(): Promise<void> {
  const frames = await fetchMultiTimeframe(ASSET, "scalping", undefined, {
    rebaseToLive: true,
  });
  if (!frames.primary?.length || !frames.daily?.length) {
    log("no candles");
    return;
  }

  const db = getLivePulseDb();
  const last = frames.primary[frames.primary.length - 1];
  const d = ASSETS[ASSET].decimals;

  maybeUpgradeTp1ToTp2(db, last);

  if (!openTrade) {
    const resumed = getOpenOrLatestPulse(db);
    if (resumed?.outcome === "OPEN") {
      openTrade = resumed;
      log("resumed OPEN", openTrade.direction, openTrade.entry);
    }
  }

  if (openTrade) {
    if (!openTrade.executedAt) {
      const state = pendingEntryState(
        openTrade.direction,
        openTrade.entry,
        openTrade.sl,
        openTrade.tp1,
        openTrade.timestamp,
        last,
        entryTolerance(ASSETS[ASSET], "scalping", last.close),
      );
      if (state === "MISSED") {
        updatePulseOutcome(db, openTrade.id, "INVALIDATED", 0, Date.now());
        log("invalidated unexecuted stale lock", openTrade.direction, openTrade.entry);
        openTrade = null;
      } else if (state === "EXECUTED") {
        const at = Date.now();
        markPulseExecuted(db, openTrade.id, at);
        openTrade = { ...openTrade, executedAt: at };
        log("EXECUTED", openTrade.direction, "@", openTrade.entry);
      }
    }
    if (openTrade?.executedAt) {
      const hit = resolveBar(openTrade, last);
      if (hit) {
        updatePulseOutcome(
          db,
          openTrade.id,
          hit as PulseOutcome,
          realizedRFor(openTrade, hit),
          Date.now(),
        );
        log("resolved", openTrade.direction, hit);
        // TP1 closes the active lock for new entries; TP2 may upgrade later.
        openTrade = null;
      }
    }
  }

  if (openTrade) return;

  let sig;
  try {
    sig = generatePulseSignal(frames, ASSET, "scalping");
  } catch (e) {
    log("engine:", e instanceof Error ? e.message : e);
    return;
  }
  if (!sig) return;
  if (Date.now() - lastAlertAt < COOLDOWN_MS) return;
  if (
    !isFreshPendingEntryViable(
      sig.direction,
      sig.entry,
      sig.sl,
      sig.tp1,
      last,
      entryTolerance(ASSETS[ASSET], "scalping", last.close),
    )
  ) {
    return;
  }

  const row = signalToRow(sig, ASSET, "live");
  insertPulseRow(db, row);
  openTrade = row;
  lastAlertAt = Date.now();

  const body = [
    `${sig.direction} QS PRO @ ${sig.entry.toFixed(d)}`,
    `SL ${sig.sl.toFixed(d)} · TP1 FAST ${sig.tp1.toFixed(d)} · TP2 ${sig.tp2.toFixed(d)}`,
    `Conf ${sig.confidence}% · Fractal+SMC agree · ${sig.regime}`,
    `Exit at TP1 — more trades, lean gate`,
    ...sig.reason.slice(0, 3),
  ].join("\n");

  log("SIGNAL >>>", sig.direction, sig.entry, `conf=${sig.confidence}`);
  await dispatchTradeAlert({
    kind: "PLAN_LOCK",
    assetId: ASSET,
    mode: "pulse",
    side: sig.direction,
    title: "QS PRO SETUP",
    body,
    tagPrefix: "[QS Pro]",
  });
}

export function startPulseWorker(): void {
  if (workerRunning) {
    log("already running");
    return;
  }
  workerRunning = true;
  log("started — QS Pro (SMC + fractal agree + 0.85R), isolated");
  void (async () => {
    for (;;) {
      try {
        await tick();
      } catch (e) {
        log("tick fatal:", e instanceof Error ? e.message : e);
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  })();
}

export function shouldAutoStartPulseWorker(): boolean {
  const flag = (process.env.ENABLE_PULSE_WORKER ?? "auto").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  return Boolean(process.env.RAILWAY_ENVIRONMENT);
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("pulseBot.ts");
if (isDirect) {
  startPulseWorker();
}
