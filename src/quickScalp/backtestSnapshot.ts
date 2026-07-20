/**
 * Committed snapshot from `npm run backtest -- --strategy=quick_scalp`
 * (1y XAUUSD M5, spread 0.25, BLITZ SMC+trend gates+0.85R TP1).
 * data/ is gitignored — prod falls back to this for the badge.
 */
export const QUICK_SCALP_BACKTEST_SNAPSHOT = {
  resolved: 1083,
  wins: 917,
  losses: 166,
  winRate: 84.67220683287165,
  avgR: 0.5661228070175439,
  maxDrawdownR: -3.3,
  meta: {
    file: "data/XAUUSD_M5.json",
    days: 365,
    spread: 0.25,
    runAt: "2026-07-20",
    style: "blitz",
    gates: "SMC scalping · conf≥75 · HTF · trend regime · daily agree · TP1 0.85R",
  },
} as const;

export function isQuickScalpBacktestValidated(summary: {
  resolved: number;
  winRate: number | null;
  avgR: number | null;
}): boolean {
  return (
    summary.resolved >= 50 &&
    summary.winRate != null &&
    summary.winRate >= 55 &&
    summary.avgR != null &&
    summary.avgR > 0
  );
}
