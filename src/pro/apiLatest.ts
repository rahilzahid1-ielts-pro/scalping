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

export function buildProLatestPayload(): {
  ok: true;
  validated: boolean;
  badge: string | null;
  latest: ReturnType<typeof getLatestPro>;
  backtestSummary: ReturnType<typeof summarizePro> | null;
} {
  const liveDb = getLiveProDb();
  const latest = getLatestPro(liveDb);
  let backtestSummary = null;
  let validated = false;
  try {
    const bt = getBacktestProDb(false);
    const n = countResolvedPro(bt);
    if (n > 0) {
      backtestSummary = summarizePro(bt);
      validated = isProBacktestValidated(backtestSummary);
    }
  } catch {
    /* no backtest history */
  }

  return {
    ok: true,
    validated,
    latest,
    backtestSummary,
    badge: validated
      ? null
      : backtestSummary
        ? `UNVALIDATED — need ≥58% TP1win, n≥50, avgR>0 (now n=${backtestSummary.resolved}, wr=${backtestSummary.winRate?.toFixed(1) ?? "—"}%, avgR=${backtestSummary.avgR?.toFixed(2) ?? "—"})`
        : "UNVALIDATED — no Pro backtest history yet",
  };
}
