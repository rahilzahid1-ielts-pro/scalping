/**
 * Shared live entry filters — cut late-chase / counter-daily locks that
 * produced the 22 Jul SL cluster (BUY near spike top while daily BEARISH).
 */
import type { Candle, Side } from "../types";

/** BUY needs daily BULLISH; SELL needs daily BEARISH. NEUTRAL fails. */
export function dailyAgreesWithSide(
  side: "BUY" | "SELL",
  dailyBias: string,
): boolean {
  if (side === "BUY") return dailyBias === "BULLISH";
  return dailyBias === "BEARISH";
}

/**
 * True when price is pressed into the extreme of the recent M5 window
 * (chase into spike / dump). Lookback default = 24 bars ≈ 2h.
 */
export function isExtendedChase(
  side: "BUY" | "SELL",
  candles: Candle[],
  lookback = 24,
  extremeFrac = 0.2,
): boolean {
  if (candles.length < Math.min(12, lookback)) return false;
  const n = Math.min(lookback, candles.length);
  const window = candles.slice(-n);
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of window) {
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }
  const range = hi - lo;
  if (!(range > 0) || !Number.isFinite(range)) return false;
  const close = window[window.length - 1].close;
  if (side === "BUY") {
    return close >= hi - range * extremeFrac;
  }
  if (side === "SELL") {
    return close <= lo + range * extremeFrac;
  }
  return false;
}

export function dailyDisagreeReason(
  side: "BUY" | "SELL",
  dailyBias: string,
): string {
  return `Daily ${dailyBias} vs SMC ${side} — daily agree nahi`;
}

export function chaseBlockReason(side: "BUY" | "SELL"): string {
  return side === "BUY"
    ? "Chase block — price near 2h high (spike top); wait pullback"
    : "Chase block — price near 2h low (dump); wait bounce";
}

/**
 * Ordered gate check for lean desks (QS Pro / Fractal).
 * Returns waitReason or null if ok to emit.
 */
export function leanDeskEntryBlock(input: {
  side: Side;
  dailyBias: string;
  primary: Candle[];
}): string | null {
  if (input.side !== "BUY" && input.side !== "SELL") return "No BUY/SELL side";
  if (!dailyAgreesWithSide(input.side, input.dailyBias)) {
    return dailyDisagreeReason(input.side, input.dailyBias);
  }
  if (isExtendedChase(input.side, input.primary)) {
    return chaseBlockReason(input.side);
  }
  return null;
}
