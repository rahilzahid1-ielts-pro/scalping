import {
  getLiveQuickScalpDb,
  getLatestQuickScalp,
  getBacktestQuickScalpDb,
  summarizeQuickScalp,
  countResolvedQuickScalp,
} from "./store";
import {
  QUICK_SCALP_BACKTEST_SNAPSHOT,
  isQuickScalpBacktestValidated,
} from "./backtestSnapshot";

export function buildQuickScalpLatestPayload() {
  const liveDb = getLiveQuickScalpDb();
  const latest = getLatestQuickScalp(liveDb);
  let backtestSummary: ReturnType<typeof summarizeQuickScalp> | null = null;
  let validated = false;

  try {
    const bt = getBacktestQuickScalpDb(false);
    const n = countResolvedQuickScalp(bt);
    if (n > 0) {
      backtestSummary = summarizeQuickScalp(bt);
      validated = isQuickScalpBacktestValidated(backtestSummary);
    }
  } catch {
    /* no local DB */
  }

  if (!backtestSummary) {
    backtestSummary = {
      resolved: QUICK_SCALP_BACKTEST_SNAPSHOT.resolved,
      wins: QUICK_SCALP_BACKTEST_SNAPSHOT.wins,
      losses: QUICK_SCALP_BACKTEST_SNAPSHOT.losses,
      winRate: QUICK_SCALP_BACKTEST_SNAPSHOT.winRate,
      avgR: QUICK_SCALP_BACKTEST_SNAPSHOT.avgR,
      maxDrawdownR: QUICK_SCALP_BACKTEST_SNAPSHOT.maxDrawdownR,
    };
    validated = isQuickScalpBacktestValidated(backtestSummary);
  }

  return {
    ok: true as const,
    validated,
    latest,
    backtestSummary,
    badge: validated
      ? null
      : `UNVALIDATED — need ≥55% TP1win, n≥50, avgR>0 (n=${backtestSummary.resolved}, wr=${backtestSummary.winRate?.toFixed(1) ?? "—"}%)`,
  };
}
