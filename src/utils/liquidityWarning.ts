import type { Candle, Side } from "../types";
import { detectLiquiditySweep } from "../strategies/smartMoney";

/**
 * Tier-1 early-warning (independent of Tier-2 regime-flip; works whether
 * REGIME_FLIP_ENABLED is true or false). Display/logging only — never changes
 * locked levels, canAutoLockPlan, confluence weights, and never fires an alert.
 */

/**
 * Display penalty constants — RETIRED. Backtest showed swept plans win MORE
 * (72.5% vs 46.5% TP1), so the confidence/win% penalty was removed. Kept only for
 * reference; nothing applies them now. Any future confidence *boost* needs its own
 * out-of-sample validation before wiring.
 */
export const LIQUIDITY_WARNING_PENALTY = 12;
export const LIQUIDITY_DISPLAY_FLOOR = 50;

/** Neutral card label — the old "reversal risk" framing is contradicted by data. */
export const LIQUIDITY_WARNING_MSG = "Liquidity sweep detected mid-plan";

/**
 * A liquidity sweep AGAINST the plan direction (reversal risk), using the same
 * SMC detection as the card:
 *   SELL plan → swing-LOW sweep (sell_side): price wicked below a swing low then
 *               closed back above → bullish reversal risk.
 *   BUY plan  → swing-HIGH sweep (buy_side): price wicked above a swing high then
 *               closed back below → bearish reversal risk.
 */
export function isLiquiditySweepAgainst(side: Side, candles: Candle[]): boolean {
  if (side !== "BUY" && side !== "SELL") return false;
  const sweep = detectLiquiditySweep(candles);
  if (side === "SELL") return sweep === "sell_side";
  return sweep === "buy_side";
}
