/**
 * Rebuild FrozenPlan from calibration OPEN row when daemon plan state was lost
 * (redeploy / wiped alert-daemon-state.json) but signals.db still has the lock.
 */
import type { AssetId, TradeMode } from "../src/types";
import type { FrozenPlan } from "../src/services/tradePlan";
import { listOpenSignals } from "../src/calibration/resolveOutcomes";

export function planFromOpenSignal(
  assetId: AssetId,
  mode: TradeMode,
): FrozenPlan | null {
  const opens = listOpenSignals().filter(
    (s) =>
      s.symbol === assetId &&
      s.mode === mode &&
      s.outcome === "OPEN" &&
      (s.side === "BUY" || s.side === "SELL"),
  );
  if (opens.length === 0) return null;

  const s = opens.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b));
  const risk = Math.abs(s.entry - s.sl);
  const reward = Math.abs(s.tp1 - s.entry);

  return {
    assetId,
    mode,
    side: s.side,
    levels: {
      entry: s.entry,
      stopLoss: s.sl,
      takeProfit1: s.tp1,
      takeProfit2: s.tp2,
      takeProfit3: s.tp3,
      riskReward: risk > 0 ? reward / risk : 0,
      invalidation: s.sl,
    },
    lockedAt: s.timestamp,
    // History OPEN = user-facing active lock (not a fresh zone wait)
    status: "IN_TRADE_HINT",
    note: "Resumed from OPEN History lock (daemon plan was missing after restart)",
    lockedConfidence: s.confidence,
    lockedWinProbability: s.winChanceDisplayed ?? s.confidence,
  };
}
