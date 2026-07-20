/**
 * Rebuild FrozenPlan from calibration OPEN row when daemon plan state was lost
 * (redeploy / wiped alert-daemon-state.json) but signals.db still has the lock.
 */
import type { AssetId, TradeMode } from "../src/types";
import type { FrozenPlan } from "../src/services/tradePlan";
import { getActiveOpenLock } from "../src/history/activeLock";

export function planFromOpenSignal(
  assetId: AssetId,
  mode: TradeMode,
): FrozenPlan | null {
  if (assetId !== "XAUUSD") return null;
  const open = getActiveOpenLock(mode === "intraday" ? "intraday" : "scalp");
  if (!open) return null;

  const risk = Math.abs(open.entry - open.sl);
  const reward = Math.abs(open.tp1 - open.entry);
  const entered = open.executedAt != null;

  return {
    assetId,
    mode,
    side: open.direction,
    levels: {
      entry: open.entry,
      stopLoss: open.sl,
      takeProfit1: open.tp1,
      takeProfit2: open.tp2,
      takeProfit3: open.tp2,
      riskReward: risk > 0 ? reward / risk : 0,
      invalidation: open.sl,
    },
    lockedAt: open.time,
    status: entered ? "IN_TRADE_HINT" : "WAITING_ENTRY",
    note: entered
      ? "Resumed from History OPEN (entry already hit)"
      : "Resumed from History OPEN — waiting for entry",
    lockedConfidence: open.confidence,
    lockedWinProbability: open.confidence,
  };
}
