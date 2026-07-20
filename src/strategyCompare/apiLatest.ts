import type { CompareStrategy } from "./store";
import {
  countResolvedStrategy,
  getBacktestStrategyDb,
  getLatestStrategySignal,
  getLiveStrategyDb,
  summarizeStrategy,
} from "./store";
import {
  CIPHER_B_BACKTEST_SNAPSHOT,
  FRACTAL_BACKTEST_SNAPSHOT,
  isCompareBacktestValidated,
} from "./backtestSnapshot";

/** Shared JSON shape for GET /api/{cipherbclone|fractal}/latest */
export function buildLatestPayload(strategy: CompareStrategy) {
  const liveDb = getLiveStrategyDb();
  const latest = getLatestStrategySignal(liveDb, strategy);
  let validated = false;
  let backtestSummary: ReturnType<typeof summarizeStrategy> | null = null;
  try {
    const bt = getBacktestStrategyDb(false);
    const n = countResolvedStrategy(bt, strategy);
    if (n > 0) {
      backtestSummary = summarizeStrategy(bt, strategy);
      validated = isCompareBacktestValidated(backtestSummary);
    }
  } catch {
    /* backtest db may not exist yet */
  }

  if (!backtestSummary) {
    const snap =
      strategy === "cipher_b_clone"
        ? CIPHER_B_BACKTEST_SNAPSHOT
        : strategy === "fractal"
          ? FRACTAL_BACKTEST_SNAPSHOT
          : null;
    if (snap) {
      backtestSummary = {
        resolved: snap.resolved,
        wins: snap.wins,
        losses: snap.losses,
        winRate: snap.winRate,
        avgR: snap.avgR,
        maxDrawdownR: snap.maxDrawdownR,
      };
      validated = isCompareBacktestValidated(backtestSummary);
    }
  }

  return {
    ok: true,
    validated,
    badge: validated
      ? null
      : backtestSummary
        ? `UNVALIDATED — need ≥55% TP1win, n≥50, avgR>0 (n=${backtestSummary.resolved}, wr=${backtestSummary.winRate?.toFixed(1) ?? "—"}%)`
        : "UNVALIDATED — no backtest history yet",
    latest: latest
      ? {
          direction: latest.direction,
          entry: latest.entry,
          sl: latest.sl,
          tp1: latest.tp1,
          tp2: latest.tp2,
          reason: latest.reason,
          outcome: latest.outcome,
          time: latest.time,
        }
      : null,
    backtestSummary,
  };
}
