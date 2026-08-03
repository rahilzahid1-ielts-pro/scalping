/**
 * Probeb SMC / Cipher-B style levels — swing structure SL + R-multiple TPs.
 * Same idea as cipherBLive: structure stop beyond recent swing, TP1 @ 0.9R, TP2 @ 1.6R.
 */
import type { Candle } from "../types";
import { atr, roundPrice, swingHighsLows } from "../strategies/indicators";

export type ProbebLevels = {
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  /** Price-action band (SL ↔ far target) — "kahan se kahan tak". */
  from: number;
  to: number;
  risk: number;
  rrTp1: number;
  method: "smc_swing";
};

const RR_TP1 = 0.9;
const RR_TP2 = 1.6;
const SWING_LOOKBACK = 12;
const ATR_SL_MULT = 0.85;
const ATR_FLOOR_MULT = 0.45;
const DECIMALS = 2;

function recentSwingLevel(
  candles: Candle[],
  side: "BUY" | "SELL",
  lookback = SWING_LOOKBACK,
): number | null {
  if (candles.length < 5) return null;
  const slice = candles.slice(-lookback);
  if (side === "BUY") {
    const lo = Math.min(...slice.map((c) => c.low));
    return Number.isFinite(lo) ? lo : null;
  }
  const hi = Math.max(...slice.map((c) => c.high));
  return Number.isFinite(hi) ? hi : null;
}

function lastSwingGuard(
  candles: Candle[],
  side: "BUY" | "SELL",
): number | null {
  const { highs, lows } = swingHighsLows(candles, 2, 2);
  if (side === "BUY") {
    const last = lows[lows.length - 1];
    return last?.price ?? null;
  }
  const last = highs[highs.length - 1];
  return last?.price ?? null;
}

/**
 * Build advisory SL/TP for a Probeb lean — Cipher B + SMC structure style.
 */
export function buildProbebSmcLevels(
  candles: Candle[],
  side: "BUY" | "SELL",
  entryPrice: number,
): ProbebLevels | null {
  if (!(Number.isFinite(entryPrice) && entryPrice > 0)) return null;
  if (candles.length < 30) return null;

  const atrSeries = atr(candles, 14);
  const atrVal = atrSeries[atrSeries.length - 1];
  if (!(Number.isFinite(atrVal) && atrVal > 0)) return null;

  const entry = roundPrice(entryPrice, DECIMALS);
  const swing = recentSwingLevel(candles, side);
  const guard = lastSwingGuard(candles, side);
  const atrSl =
    side === "BUY" ? entry - atrVal * ATR_SL_MULT : entry + atrVal * ATR_SL_MULT;
  const atrFloor =
    side === "BUY"
      ? entry - atrVal * ATR_FLOOR_MULT
      : entry + atrVal * ATR_FLOOR_MULT;

  let sl: number;
  if (side === "BUY") {
    sl = atrSl;
    if (swing != null) sl = Math.min(sl, swing - atrVal * 0.15);
    if (guard != null) sl = Math.min(sl, guard - atrVal * 0.2);
    sl = Math.min(sl, atrFloor);
  } else {
    sl = atrSl;
    if (swing != null) sl = Math.max(sl, swing + atrVal * 0.15);
    if (guard != null) sl = Math.max(sl, guard + atrVal * 0.2);
    sl = Math.max(sl, atrFloor);
  }

  sl = roundPrice(sl, DECIMALS);
  const risk = Math.abs(entry - sl);
  if (!(risk >= 0.5)) return null;

  const tp1 = roundPrice(
    side === "BUY" ? entry + risk * RR_TP1 : entry - risk * RR_TP1,
    DECIMALS,
  );
  const tp2 = roundPrice(
    side === "BUY" ? entry + risk * RR_TP2 : entry - risk * RR_TP2,
    DECIMALS,
  );
  const from = roundPrice(Math.min(sl, tp2), DECIMALS);
  const to = roundPrice(Math.max(sl, tp2), DECIMALS);

  return {
    entry,
    sl,
    tp1,
    tp2,
    from,
    to,
    risk: roundPrice(risk, DECIMALS),
    rrTp1: RR_TP1,
    method: "smc_swing",
  };
}
