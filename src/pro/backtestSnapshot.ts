/**
 * Committed snapshot from `npm run backtest:pro` (1y XAUUSD M5, spread 0.25).
 * `data/` is gitignored so Railway/prod has no backtest-results.db —
 * API falls back to this for the validated badge + summary.
 *
 * Re-run backtest:pro and update these numbers when the strategy changes.
 */
export const PRO_BACKTEST_SNAPSHOT = {
  resolved: 785,
  wins: 634,
  losses: 151,
  winRate: 80.76433121019109,
  avgR: 0.6152866242038216,
  maxDrawdownR: -6,
  meta: {
    file: "data/XAUUSD_M5.json",
    days: 365,
    spread: 0.25,
    runAt: "2026-07-22",
    gates: "conf≥80, HTF aligned, no conflict, TREND only, daily agree or conf≥85 M15+H1 breakout",
  },
} as const;
