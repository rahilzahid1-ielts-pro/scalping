/**
 * Shared JSON for GET /api/pro/latest (vite + prodServer).
 */
import {
  getLiveProDb,
  getLatestPro,
  getBacktestProDb,
  summarizePro,
  countResolvedPro,
  isProBacktestValidated,
} from "./store";
import { PRO_BACKTEST_SNAPSHOT } from "./backtestSnapshot";

export function buildProLatestPayload(): {
  ok: true;
  validated: boolean;
  badge: string | null;
  latest: ReturnType<typeof getLatestPro>;
  backtestSummary: {
    resolved: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgR: number | null;
    maxDrawdownR: number | null;
  } | null;
} {
  const liveDb = getLiveProDb();
  const latest = getLatestPro(liveDb);
  let backtestSummary: {
    resolved: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgR: number | null;
    maxDrawdownR: number | null;
  } | null = null;
  let validated = false;

  try {
    const bt = getBacktestProDb(false);
    const n = countResolvedPro(bt);
    if (n > 0) {
      backtestSummary = summarizePro(bt);
      validated = isProBacktestValidated(backtestSummary);
    }
  } catch {
    /* no local backtest DB — fall through to snapshot */
  }

  // data/ is gitignored; prod has no backtest-results.db — use committed snapshot.
  if (!backtestSummary) {
    backtestSummary = {
      resolved: PRO_BACKTEST_SNAPSHOT.resolved,
      wins: PRO_BACKTEST_SNAPSHOT.wins,
      losses: PRO_BACKTEST_SNAPSHOT.losses,
      winRate: PRO_BACKTEST_SNAPSHOT.winRate,
      avgR: PRO_BACKTEST_SNAPSHOT.avgR,
      maxDrawdownR: PRO_BACKTEST_SNAPSHOT.maxDrawdownR,
    };
    validated = isProBacktestValidated(backtestSummary);
  }

  return {
    ok: true,
    validated,
    latest,
    backtestSummary,
    badge: validated
      ? null
      : `UNVALIDATED — need ≥58% TP1win, n≥50, avgR>0 (now n=${backtestSummary.resolved}, wr=${backtestSummary.winRate?.toFixed(1) ?? "—"}%, avgR=${backtestSummary.avgR?.toFixed(2) ?? "—"})`,
  };
}
