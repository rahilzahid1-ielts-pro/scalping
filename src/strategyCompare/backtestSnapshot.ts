/**
 * Committed backtest snapshots (1y XAUUSD M5, spread 0.25, SMC dual-confirm).
 * data/ is gitignored — prod falls back to these for the badge.
 */
export const CIPHER_B_BACKTEST_SNAPSHOT = {
  resolved: 523,
  wins: 434,
  losses: 89,
  winRate: 82.98279158699809,
  avgR: 0.5767877629063098,
  maxDrawdownR: -4.0,
};

export const FRACTAL_BACKTEST_SNAPSHOT = {
  resolved: 626,
  wins: 566,
  losses: 60,
  winRate: 90.41533546325878,
  avgR: 0.7182108626198084,
  maxDrawdownR: -5.1,
};

export function isCompareBacktestValidated(summary: {
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
