import { CONFLICT_CAP_PCT } from "./types";

/**
 * Displayed "Win chance" must be a direct function of Confidence — never an
 * independent formula (the old rangePrediction winProb invented its own number).
 *
 * Until the live calibration gate opens (≥14d / n≥50 / ≥2 regimes / ≥5 days),
 * this is identity: winChanceDisplayed === confidence.
 *
 * When the gate is open, Node-side callers may pass `calibrated` from
 * getCalibratedWinChance(); conflict-capped setups still clamp to CONFLICT_CAP_PCT.
 */
export function displayedWinChance(
  confidence: number,
  opts?: { conflictCapped?: boolean; calibrated?: number | null },
): number {
  let win =
    opts?.calibrated != null && Number.isFinite(opts.calibrated)
      ? opts.calibrated
      : confidence;
  if (opts?.conflictCapped) {
    win = Math.min(win, CONFLICT_CAP_PCT);
  }
  return Math.round(win);
}
