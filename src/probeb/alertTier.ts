/**
 * Probeb page / push alert tiers from win% + confidence.
 * Yellow: both >60. Green: both ≥70.
 */
export type ProbebAlertTier = "yellow" | "green" | null;

export function probebAlertTier(
  winPct: number,
  confPct: number,
): ProbebAlertTier {
  if (!(Number.isFinite(winPct) && Number.isFinite(confPct))) return null;
  if (winPct >= 70 && confPct >= 70) return "green";
  if (winPct > 60 && confPct > 60) return "yellow";
  return null;
}
