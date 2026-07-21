/**
 * Committed snapshot from CSV M5 walk-forward (QS Pro / Pulse).
 * data/ is gitignored — prod falls back to this for the badge.
 */
export const PULSE_BACKTEST_SNAPSHOT = {
  resolved: 870,
  wins: 764,
  losses: 106,
  winRate: 87.816091954023,
  avgR: 0.6245977011494249,
  maxDrawdownR: -4.35,
  meta: {
    file: "data/XAU_5m_data.csv",
    days: 365,
    spread: 0.25,
    runAt: "2026-07-20",
    style: "qs_pro",
    gates: "SMC scalping + fractal direction agree + TP1 0.85R",
    vsQuickScalp: "n=922 wr=81.8% avgR=0.51",
    vsPro: "n=583 wr=77.0% avgR=0.54",
  },
} as const;

export function isPulseBacktestValidated(summary: {
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
