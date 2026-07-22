/**
 * Committed snapshot from `npx tsx scripts/backtestIntra30.ts`
 * (365d XAUUSD M5, spread 0.25, pehli-strong → next open, TP1$3/TP2$6/SL$3).
 * `data/` is gitignored — Railway/prod falls back here for the badge.
 *
 * NOTE: fails validation gate (need ≥58% TP1win, n≥50, avgR>0).
 * Re-run backtest and update when the formula changes.
 */
export const INTRA30_BACKTEST_SNAPSHOT = {
  resolved: 3133,
  wins: 1199,
  losses: 1934,
  winRate: 38.27002872646026,
  avgR: -0.08394510054261091,
  maxDrawdownR: -268,
  meta: {
    file: "data/XAUUSD_M5.json",
    days: 365,
    spread: 0.25,
    runAt: "2026-07-22",
    rules:
      "pehli strong M5 body≥85% wick≤8% → next open; TP1$3 TP2$6 SL$3; weak exit after TP1; multi-open",
  },
} as const;
