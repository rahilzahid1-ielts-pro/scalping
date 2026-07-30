/**
 * Shared Probeb live sync — resolve pending + insert one row per closed M5.
 * Called from the worker AND /api/probeb/latest so the UI poll itself advances
 * state (Yahoo M5 alone is too laggy / gappy for GC=F).
 */
import { fetchMultiTimeframe } from "../services/marketData";
import {
  diagnoseProbeb,
  m5FloorMs,
  nextCandleSide,
  M5_MS,
  type ProbebPrediction,
} from "../strategies/probebEngine";
import { voidProbebQuoteSpikeTrades } from "../demoAccount/engine";
import { refreshProbebLiveM5 } from "./liveM5";
import {
  isProbebAutoTradeSetup,
  tryProbebAutoTrade,
  type ProbebAutoTradeResult,
} from "./autoTrade";
import {
  getLatestProbeb,
  getLiveProbebDb,
  insertProbebRow,
  listPendingProbeb,
  listRecentProbeb,
  predictionToRow,
  resolveProbeb,
  forceResolveProbeb,
} from "./store";
import type { Candle } from "../types";

export type ProbebSyncResult = {
  primary: Candle[];
  livePrice: number;
  resolved: number;
  repaired: number;
  inserted: ProbebPrediction | null;
  signal: ProbebPrediction | null;
  waitReason: string;
  autoTrade: ProbebAutoTradeResult | null;
};

function resolvePendingOn(primary: Candle[], now = Date.now()): number {
  const db = getLiveProbebDb();
  const byTime = new Map(primary.map((c) => [c.time, c]));
  const slot = m5FloorMs(now);
  let n = 0;

  for (const pending of listPendingProbeb(db)) {
    const predBar = m5FloorMs(pending.barTime);
    const targetBar = predBar + M5_MS;
    // Target must be fully closed.
    if (targetBar >= slot) continue;

    const a = byTime.get(predBar);
    const b = byTime.get(targetBar);
    let actual = a && b ? sideFromCloses(a, b) : null;

    // Gap in feed: use sequential neighbors if exact target missing.
    if (!actual) {
      const idx = primary.findIndex((c) => c.time === predBar);
      if (idx >= 0 && idx + 1 < primary.length) {
        actual = nextCandleSide(primary, idx);
      }
    }
    if (!actual) continue;

    resolveProbeb(db, pending.id, actual);
    n += 1;
  }
  return n;
}

function sideFromCloses(
  _a: Candle,
  b: Candle,
): "BUY" | "SELL" | null {
  // Target candle body = chart green/red (same as nextCandleSide).
  if (!(Number.isFinite(b.close) && Number.isFinite(b.open))) return null;
  if (b.close > b.open) return "BUY";
  if (b.close < b.open) return "SELL";
  if (Number.isFinite(_a.close)) {
    if (b.close > _a.close) return "BUY";
    if (b.close < _a.close) return "SELL";
  }
  return b.high - b.close >= b.close - b.low ? "SELL" : "BUY";
}

function repairSettledOn(primary: Candle[], now = Date.now()): number {
  const db = getLiveProbebDb();
  const byTime = new Map(primary.map((c) => [c.time, c]));
  const slot = m5FloorMs(now);
  let n = 0;
  for (const row of listRecentProbeb(db, 48)) {
    if (row.actualSide == null) continue;
    const predBar = m5FloorMs(row.barTime);
    const targetBar = predBar + M5_MS;
    if (targetBar >= slot) continue;
    const a = byTime.get(predBar);
    const b = byTime.get(targetBar);
    if (!a || !b) continue;
    const actual = sideFromCloses(a, b);
    if (!actual || actual === row.actualSide) continue;
    forceResolveProbeb(db, row.id, actual);
    n += 1;
  }
  return n;
}

function maybeInsert(pred: ProbebPrediction): boolean {
  const db = getLiveProbebDb();
  const latest = getLatestProbeb(db);
  if (latest && m5FloorMs(latest.barTime) === pred.barTime) return false;
  insertProbebRow(db, predictionToRow(pred, "live"));
  return true;
}

export async function syncProbebLive(): Promise<ProbebSyncResult> {
  const { primary, livePrice } = await refreshProbebLiveM5();
  try {
    const ref = primary.length ? primary[primary.length - 1]?.close : null;
    voidProbebQuoteSpikeTrades(ref ?? livePrice);
  } catch {
    /* demo repair optional */
  }
  const resolved = resolvePendingOn(primary);
  const repaired = repairSettledOn(primary);

  // HTF frames from Yahoo (lag OK for bias); primary = live M5 clock.
  let confirmation: Candle[] = [];
  let bias: Candle[] = [];
  try {
    const frames = await fetchMultiTimeframe("XAUUSD", "scalping", livePrice, {
      rebaseToLive: false,
    });
    confirmation = frames.confirmation;
    bias = frames.bias;
  } catch {
    /* HTF optional — momentum fallback still works */
  }

  const diag = diagnoseProbeb({ primary, confirmation, bias });
  let inserted: ProbebPrediction | null = null;
  if (diag.signal && maybeInsert(diag.signal)) {
    inserted = diag.signal;
  }

  let autoTrade: ProbebAutoTradeResult | null = null;
  const tradePred = inserted ?? diag.signal;
  if (tradePred && isProbebAutoTradeSetup(tradePred)) {
    autoTrade = tryProbebAutoTrade(tradePred, livePrice, { primary });
  }

  return {
    primary,
    livePrice,
    resolved,
    repaired,
    inserted,
    signal: diag.signal,
    waitReason: diag.waitReason,
    autoTrade,
  };
}
