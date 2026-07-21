/**
 * QS Pro (Pulse) bot — SMC + fractal-agree + fast TP1.
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
let lastAlertDirection: "BUY" | "SELL" | null = null;
let openTrade: PulseRow | null = null;

function log(...args: unknown[]) {
  console.log(`[pulse ${new Date().toLocaleTimeString()}]`, ...args);
}

function resolveBar(row: PulseRow, bar: Candle): "TP1_HIT" | "SL_HIT" | null {
  const buy = row.direction === "BUY";
  const hitSl = buy ? bar.low <= row.sl : bar.high >= row.sl;
  const hitTp = buy ? bar.high >= row.tp1 : bar.low <= row.tp1;
  if (hitSl && hitTp) return "SL_HIT";
  if (hitSl) return "SL_HIT";
  if (hitTp) return "TP1_HIT";
  return null;
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

  if (!openTrade) {
    const resumed = getOpenOrLatestPulse(db);
    if (resumed && lastAlertDirection == null) {
      lastAlertDirection = resumed.direction;
      lastAlertAt = resumed.timestamp;
    }
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
        const risk = Math.abs(openTrade.entry - openTrade.sl);
        const tp1R = risk > 0 ? Math.abs(openTrade.tp1 - openTrade.entry) / risk : 0.85;
        const r = hit === "TP1_HIT" ? tp1R : -1;
        updatePulseOutcome(db, openTrade.id, hit, r, Date.now());
        log("resolved", openTrade.direction, hit);
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
  // Suppress duplicate same-side setups, but never let an invalidated SELL
  // cooldown hide a fresh BUY reversal (or vice versa).
  if (
    sig.direction === lastAlertDirection &&
    Date.now() - lastAlertAt < COOLDOWN_MS
  ) {
    return;
  }
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
  lastAlertDirection = sig.direction;

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
