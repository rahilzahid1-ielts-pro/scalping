import {
  CONFIDENCE_BUCKETS,
  MIN_CALENDAR_DAYS_FOR_CALIBRATION,
  MIN_DAYS_BEFORE_DISPLAY_RECAL,
  MIN_REGIMES_FOR_CALIBRATION,
  MIN_SAMPLES_FOR_CALIBRATION,
  type LoggedSignal,
  type RegimeTag,
} from "./types";
import { listAllSignals } from "./db";

export interface CalibratedWinResult {
  /** Empirical win rate 0–100, or null if not ready */
  calibrated: number | null;
  rawClaimed: number;
  sampleSize: number;
  /** True only when all recalibration unlock gates pass */
  ready: boolean;
  bucketLabel: string;
  untrusted: boolean;
  regimeCount: number;
  calendarDayCount: number;
}

function bucketFor(confidence: number) {
  return (
    CONFIDENCE_BUCKETS.find((b) => confidence >= b.min && confidence < b.max) ??
    CONFIDENCE_BUCKETS[CONFIDENCE_BUCKETS.length - 1]
  );
}

/** Primary sample set: TP1 WIN or LOSS (excludes INVALIDATED / still-OPEN). */
export function resolvedTp1Samples(signals: LoggedSignal[]): LoggedSignal[] {
  return signals.filter((s) => s.outcomeTp1 === "WIN" || s.outcomeTp1 === "LOSS");
}

export function calendarDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function distinctRegimes(signals: LoggedSignal[]): RegimeTag[] {
  const set = new Set<RegimeTag>();
  for (const s of signals) {
    if (s.regime) set.add(s.regime);
  }
  return [...set];
}

export function distinctCalendarDays(signals: LoggedSignal[]): string[] {
  return [...new Set(signals.map((s) => calendarDayKey(s.resolvedAt ?? s.timestamp)))];
}

function oldestResolvedAgeDays(signals: LoggedSignal[]): number {
  const resolved = resolvedTp1Samples(signals);
  if (resolved.length === 0) return 0;
  const oldest = Math.min(...resolved.map((s) => s.resolvedAt ?? s.timestamp));
  return (Date.now() - oldest) / (24 * 60 * 60 * 1000);
}

export function sampleIndependenceOk(sample: LoggedSignal[]): {
  ok: boolean;
  regimeCount: number;
  calendarDayCount: number;
} {
  const regimeCount = distinctRegimes(sample).length;
  const calendarDayCount = distinctCalendarDays(sample).length;
  return {
    ok:
      regimeCount >= MIN_REGIMES_FOR_CALIBRATION &&
      calendarDayCount >= MIN_CALENDAR_DAYS_FOR_CALIBRATION,
    regimeCount,
    calendarDayCount,
  };
}

/**
 * Empirical win chance for a confidence bucket (TP1 definition).
 * Unlock requires ALL of:
 *   ≥14 days resolved history, ≥50 samples, ≥2 regimes, ≥5 calendar days.
 * Until then UI must keep showing the raw formula win%.
 */
export function getCalibratedWinChance(
  confidence: number,
  side: "BUY" | "SELL",
  mode: string,
  signals?: LoggedSignal[],
): CalibratedWinResult {
  const all = signals ?? listAllSignals();
  const bucket = bucketFor(confidence);
  const pool = resolvedTp1Samples(all).filter(
    (s) =>
      s.confidence >= bucket.min &&
      s.confidence < bucket.max &&
      s.side === side &&
      s.mode === mode,
  );

  let sample = pool;
  if (sample.length < MIN_SAMPLES_FOR_CALIBRATION) {
    sample = resolvedTp1Samples(all).filter(
      (s) =>
        s.confidence >= bucket.min &&
        s.confidence < bucket.max &&
        s.side === side,
    );
  }
  if (sample.length < MIN_SAMPLES_FOR_CALIBRATION) {
    sample = resolvedTp1Samples(all).filter(
      (s) => s.confidence >= bucket.min && s.confidence < bucket.max,
    );
  }

  const tp = sample.filter((s) => s.outcomeTp1 === "WIN").length;
  const sl = sample.filter((s) => s.outcomeTp1 === "LOSS").length;
  const n = tp + sl;
  const actual = n > 0 ? (tp / n) * 100 : null;
  const claimedMid = (bucket.min + bucket.max) / 2;
  const days = oldestResolvedAgeDays(all);
  const indep = sampleIndependenceOk(sample);
  const ready =
    n >= MIN_SAMPLES_FOR_CALIBRATION &&
    days >= MIN_DAYS_BEFORE_DISPLAY_RECAL &&
    indep.ok &&
    actual != null;
  const untrusted = actual != null && claimedMid - actual > 15;

  return {
    calibrated: ready ? Math.round(actual! * 10) / 10 : null,
    rawClaimed: confidence,
    sampleSize: n,
    ready,
    bucketLabel: bucket.label,
    untrusted,
    regimeCount: indep.regimeCount,
    calendarDayCount: indep.calendarDayCount,
  };
}

export function calibrationDisplayGateOk(signals?: LoggedSignal[]): boolean {
  const all = signals ?? listAllSignals();
  return oldestResolvedAgeDays(all) >= MIN_DAYS_BEFORE_DISPLAY_RECAL;
}
