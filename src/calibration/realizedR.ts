import type { LoggedSignal } from "./types";

/**
 * Full-plan realized R under standard 3-part scaling:
 * - Close 1/3 of size at TP1, 1/3 at TP2, 1/3 at TP3
 * - After TP1, stop for the remaining 2/3 is moved to entry (breakeven)
 * - If SL hits before TP1: -1.0 R on the full position
 * - Remaining thirds stopped at breakeven contribute 0 R
 *
 * This is the assumption used for `realizedRFull` / calibration `avgR_full`.
 */
export function computeRealizedRFull(sig: LoggedSignal): number | null {
  if (sig.outcomeTp1 === "LOSS") return -1;
  if (sig.outcomeTp1 !== "WIN") return null;

  const risk = Math.abs(sig.entry - sig.sl) || 1e-9;
  const rAt = (px: number) =>
    sig.side === "BUY" ? (px - sig.entry) / risk : (sig.entry - px) / risk;

  let total = (1 / 3) * rAt(sig.tp1);
  if (sig.tp2Hit) total += (1 / 3) * rAt(sig.tp2);
  if (sig.tp3Hit) total += (1 / 3) * rAt(sig.tp3);
  // thirds still open or stopped at entry → 0 contribution

  return Math.round(total * 1000) / 1000;
}

export function realizedRAtExit(
  side: "BUY" | "SELL",
  entry: number,
  sl: number,
  exit: number,
): number {
  const risk = Math.abs(entry - sl) || 1e-9;
  if (side === "BUY") return (exit - entry) / risk;
  return (entry - exit) / risk;
}
