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
import { probebFormingM5, refreshProbebLiveM5 } from "./liveM5";
import { buildProbebReachTarget, type ProbebReach } from "./levels";
import {
  predictionFromLockedRow,
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
  replacePendingProbeb,
  resolveProbeb,
  forceResolveProbeb,
  type ProbebRow,
} from "./store";
import type { Candle } from "../types";

export type ProbebSyncResult = {
  primary: Candle[];
  livePrice: number;
  resolved: number;
  repaired: number;
  inserted: ProbebPrediction | null;
  signal: ProbebPrediction | null;
  /** DB-locked lean for the current closed M5 — UI must prefer this (no flip). */
  locked: ProbebRow | null;
  /** Predicted reach level — where lean says price can go (not SL/TP). */
  reach: ProbebReach | null;
  /** @deprecated alias of reach */
  levels: ProbebReach | null;
  waitReason: string;
  autoTrade: ProbebAutoTradeResult | null;
};

/** Clear live body on the forming (target) M5 — ignore tiny doji/noise. */
function formingBodySide(f: Candle): ProbebPrediction["side"] | null {
  const range = f.high - f.low;
  const body = f.close - f.open;
  if (!(range > 0) || !Number.isFinite(body)) return null;
  if (Math.abs(body) < 1.0) return null;
  if (Math.abs(body) / range < 0.25) return null;
  return body < 0 ? "SELL" : "BUY";
}

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
  const { primary, livePrice, saneMid } = await refreshProbebLiveM5();
  try {
    voidProbebQuoteSpikeTrades(livePrice);
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
  // Last closed still miles from live after scrub → never lock STRONG / auto off garbage.
  const lastClose = primary.length ? primary[primary.length - 1]?.close : null;
  const spikeVsLive =
    lastClose != null &&
    Number.isFinite(livePrice) &&
    Math.abs(livePrice - lastClose) > 20;

  let inserted: ProbebPrediction | null = null;
  if (diag.signal && !spikeVsLive && maybeInsert(diag.signal)) {
    inserted = diag.signal;
  }

  const db = getLiveProbebDb();
  let latest = getLatestProbeb(db);

  // Spike scrub can flip the real lean — rewrite still-pending lock so hero
  // doesn't keep a fake STRONG BUY while gold dumps on the live tape.
  if (
    diag.signal &&
    !spikeVsLive &&
    latest &&
    latest.actualSide == null &&
    m5FloorMs(latest.barTime) === m5FloorMs(diag.signal.barTime) &&
    (latest.predictedSide !== diag.signal.side ||
      (latest.probabilityPct >= 60 && diag.signal.quality === "weak") ||
      Math.abs(latest.probabilityPct - diag.signal.probabilityPct) >= 12)
  ) {
    const row = predictionToRow(diag.signal, "live");
    if (replacePendingProbeb(db, row)) {
      latest = getLatestProbeb(db);
      inserted = diag.signal;
    }
  }

  const locked =
    diag.signal &&
    latest &&
    m5FloorMs(latest.barTime) === m5FloorMs(diag.signal.barTime)
      ? latest
      : null;

  // Live forming target candle already has a clear red/green body — don't keep
  // the opposite locked lean on the hero (BUY while red dumps).
  const forming = probebFormingM5();
  const formSide = forming ? formingBodySide(forming) : null;
  if (
    formSide &&
    latest &&
    latest.actualSide == null &&
    forming &&
    latest.barTime + M5_MS === forming.time &&
    latest.predictedSide !== formSide
  ) {
    const fixed: ProbebPrediction = {
      side: formSide,
      probabilityPct: 58,
      confidencePct: 45,
      bucket: diag.signal?.bucket ?? latest.bucket,
      sampleN: diag.signal?.sampleN ?? latest.sampleN,
      barTime: latest.barTime,
      targetBarTime: latest.barTime + M5_MS,
      quality: "normal",
      reason: [
        `Agli candle → ${formSide}`,
        `Live ${formSide === "SELL" ? "red" : "green"} body — flipped from ${latest.predictedSide}`,
        `Forming M5 body vs locked lean`,
      ],
    };
    if (replacePendingProbeb(db, predictionToRow(fixed, "live"))) {
      latest = getLatestProbeb(db);
      inserted = fixed;
    }
  }

  const lockedNow =
    latest &&
    diag.signal &&
    m5FloorMs(latest.barTime) === m5FloorMs(diag.signal.barTime)
      ? latest
      : latest && !diag.signal
        ? latest
        : locked;

  const tradePred = spikeVsLive
    ? null
    : inserted
      ? inserted
      : lockedNow
        ? predictionFromLockedRow(lockedNow)
        : diag.signal;

  let autoTrade: ProbebAutoTradeResult | null = null;
  if (spikeVsLive) {
    autoTrade = {
      ok: false,
      reason: `M5 OHLC spike vs live ${livePrice.toFixed(2)} — signal scrub, no auto`,
    };
  } else if (tradePred) {
    // Mid-candle body flip is informational — don't auto off a live rewrite.
    if (formSide && tradePred.reason.some((r) => /flipped from/i.test(r))) {
      autoTrade = {
        ok: false,
        reason: `live ${formSide} body — lean updated, auto wait next M5 lock`,
      };
    } else {
      autoTrade = tryProbebAutoTrade(tradePred, livePrice, { primary, saneMid });
    }
  }

  const displayLocked = spikeVsLive ? null : lockedNow;
  const leanSide =
    displayLocked?.predictedSide ??
    inserted?.side ??
    (spikeVsLive ? null : diag.signal?.side) ??
    null;
  const leanConf =
    displayLocked?.confidencePct ??
    inserted?.confidencePct ??
    diag.signal?.confidencePct ??
    50;
  const leanQuality =
    inserted?.quality ??
    (displayLocked ? predictionFromLockedRow(displayLocked).quality : null) ??
    diag.signal?.quality ??
    "normal";
  const reach =
    leanSide != null
      ? buildProbebReachTarget(
          primary,
          leanSide,
          livePrice,
          leanConf,
          leanQuality,
        )
      : null;

  return {
    primary,
    livePrice,
    resolved,
    repaired,
    inserted,
    signal: spikeVsLive && diag.signal
      ? {
          ...diag.signal,
          quality: "weak",
          probabilityPct: Math.min(diag.signal.probabilityPct, 52),
          confidencePct: Math.min(diag.signal.confidencePct, 20),
          reason: [
            ...diag.signal.reason,
            `Scrub: last M5 ${lastClose?.toFixed(2)} vs live ${livePrice.toFixed(2)} — not trusted`,
          ],
        }
      : inserted ?? diag.signal,
    locked: displayLocked,
    reach,
    levels: reach,
    waitReason: diag.waitReason,
    autoTrade,
  };
}
