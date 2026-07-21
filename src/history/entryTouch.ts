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

  // Price reached the target or invalidation side without a post-lock entry
  // touch. The move was missed; never keep this stale lock as an active trade.
  if (direction === "BUY" && (bar.close >= tp1 || bar.close <= sl)) return "MISSED";
  if (direction === "SELL" && (bar.close <= tp1 || bar.close >= sl)) return "MISSED";

  return "WAITING";
}
