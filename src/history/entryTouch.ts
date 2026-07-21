import { isTooLateToEnter } from "../utils/tradeSafety";

export type PendingEntryState = "WAITING" | "EXECUTED" | "MISSED";

/**
 * Evaluate a pending limit entry without using pre-lock candle movement.
 *
 * The current candle range is trusted only when that candle opened after the
 * lock. On the lock candle, only the current close may activate the entry.
 */
export function pendingEntryState(
  direction: "BUY" | "SELL",
  entry: number,
  sl: number,
  tp1: number,
  lockedAt: number,
  bar: { time: number; high: number; low: number; close: number },
  tolerance: number,
): PendingEntryState {
  const values = [entry, sl, tp1, lockedAt, bar.time, bar.high, bar.low, bar.close];
  if (!values.every(Number.isFinite)) return "WAITING";

  const currentNearEntry = Math.abs(bar.close - entry) <= tolerance;
  const wholeBarIsPostLock = bar.time >= lockedAt;
  const postLockBarTouched =
    wholeBarIsPostLock && bar.low <= entry && bar.high >= entry;

  if (currentNearEntry || postLockBarTouched) return "EXECUTED";

  // Full TP1/SL miss only — 0.5R target-side early release was confirmed harmful
  // for Main Scalp session-lock (lock churn / avgR collapse) and is not used here.
  if (direction === "BUY" && (bar.close >= tp1 || bar.close <= sl)) return "MISSED";
  if (direction === "SELL" && (bar.close <= tp1 || bar.close >= sl)) return "MISSED";

  return "WAITING";
}

/** Reject a newly generated lock whose move is already over at insertion time. */
export function isFreshPendingEntryViable(
  direction: "BUY" | "SELL",
  entry: number,
  sl: number,
  tp1: number,
  bar: { time: number; high: number; low: number; close: number },
  tolerance: number,
  now: number = Date.now(),
): boolean {
  // Keep reject-missed for brand-new inserts: if price already ran 0.5R toward
  // target, do not open a fresh chase lock. This is lock-time gating only —
  // it does not free an already-waiting plan for rapid re-lock churn.
  if (isTooLateToEnter(direction, bar.close, entry, sl)) return false;
  return pendingEntryState(direction, entry, sl, tp1, now, bar, tolerance) !== "MISSED";
}
