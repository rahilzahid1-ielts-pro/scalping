import type { MaSignal } from "../types";
import type { RegimeTag } from "./types";

/**
 * Simple regime tag from existing MA outputs (no new indicators).
 * TREND_UP / TREND_DOWN when MA trend agrees with price vs EMA200;
 * otherwise RANGE.
 */
export function deriveRegimeTag(ma: MaSignal, price: number): RegimeTag {
  if (ma.trend === "BULLISH" && price > ma.ema200) return "TREND_UP";
  if (ma.trend === "BEARISH" && price < ma.ema200) return "TREND_DOWN";
  return "RANGE";
}
