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

/** Bounce off the window extreme that invalidates a with-daily entry. */
export const COUNTER_BOUNCE_USD = 10;

/** Bars within which the directional extreme must sit to count as "fresh". */
export const FRESH_EXTREME_BARS = 6;

function windowOf(candles: Candle[], lookback: number): Candle[] | null {
  if (candles.length < 12) return null;
  return candles.slice(-Math.min(lookback, candles.length));
}

/** Index of the directional extreme: lowest low for SELL, highest high for BUY. */
function extremeIndex(side: "BUY" | "SELL", window: Candle[]): number {
  let best = side === "SELL" ? Infinity : -Infinity;
  let idx = 0;
  for (let i = 0; i < window.length; i += 1) {
    const v = side === "SELL" ? window[i].low : window[i].high;
    if (side === "SELL" ? v < best : v > best) {
      best = v;
      idx = i;
    }
  }
  return idx;
}

function meanClose(bars: Candle[]): number {
  if (!bars.length) return NaN;
  return bars.reduce((a, c) => a + c.close, 0) / bars.length;
}

/**
 * True when the directional extreme is stale — market is no longer making new
 * lows (SELL) / highs (BUY). Used to reject momentum-less fallback entries.
 */
export function hasFreshExtreme(
  side: "BUY" | "SELL",
  candles: Candle[],
  lookback = 24,
  freshBars = FRESH_EXTREME_BARS,
): boolean {
  const window = windowOf(candles, lookback);
  if (!window) return true;
  return extremeIndex(side, window) >= window.length - freshBars;
}

/**
 * True when price has already bounced meaningfully away from the window
 * extreme and short-term momentum has flipped against `side`.
 *
 * 2026-07-28: QS Pro sold 4032.72 after gold bounced ~$12 off the 4021 low —
 * `isExtendedChase` passed (price was mid-range) and the trade SL'd into the
 * continuing rally. This is the guard for that shape.
 */
export function isCounterBounce(
  side: "BUY" | "SELL",
  candles: Candle[],
  lookback = 24,
  minMoveUsd = COUNTER_BOUNCE_USD,
): boolean {
  const window = windowOf(candles, lookback);
  if (!window) return false;

  const idx = extremeIndex(side, window);
  // Extreme still fresh → genuine continuation, let it through.
  if (idx >= window.length - 3) return false;

  const extreme = side === "SELL" ? window[idx].low : window[idx].high;
  const close = window[window.length - 1].close;
  const move = side === "SELL" ? close - extreme : extreme - close;
  if (!(move >= minMoveUsd) || !Number.isFinite(move)) return false;

  const prior = meanClose(window.slice(-6, -3));
  const recent = meanClose(window.slice(-3));
  if (!Number.isFinite(prior) || !Number.isFinite(recent)) return false;

  return side === "SELL" ? recent > prior : recent < prior;
}

export function dailyDisagreeReason(
  side: "BUY" | "SELL",
  dailyBias: string,
): string {
  return `Daily ${dailyBias} vs SMC ${side} — daily agree nahi`;
}

export function counterBounceReason(side: "BUY" | "SELL"): string {
  return side === "SELL"
    ? `Bounce block — price ${COUNTER_BOUNCE_USD}$+ off 2h low aur momentum up; naya lower-low chahiye`
    : `Bounce block — price ${COUNTER_BOUNCE_USD}$+ off 2h high aur momentum down; naya higher-high chahiye`;
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
  if (isCounterBounce(input.side, input.primary)) {
    return counterBounceReason(input.side);
  }
  return null;
}
