/**
 * Committed snapshot from `npm run backtest:pro` (1y XAUUSD M5, spread 0.25).
 * `data/` is gitignored so Railway/prod has no backtest-results.db —
 * API falls back to this for the validated badge + summary.
 *
 * Re-run backtest:pro and update these numbers when the strategy changes.
 */
export const PRO_BACKTEST_SNAPSHOT = {
  resolved: 616,
  wins: 487,
  losses: 129,
  winRate: 79.05844155844156,
  avgR: 0.5811688311688312,
  maxDrawdownR: -8,
  meta: {
    file: "data/XAUUSD_M5.json",
    days: 365,
    spread: 0.25,
    runAt: "2026-07-20",
    gates: "conf≥80, HTF aligned, no conflict, TREND only, daily bias agrees",
  },
} as const;
