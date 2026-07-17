/**
 * Shared calibration report printers — used by `npm run calibrate` (live DB)
 * and `npm run backtest` (backtest DB). Same math, different data source.
 */
import {
  CONFIDENCE_BUCKETS,
  MIN_CALENDAR_DAYS_FOR_CALIBRATION,
  MIN_REGIMES_FOR_CALIBRATION,
  MIN_SAMPLES_FOR_CALIBRATION,
  type CalibrationBucketRow,
  type LoggedSignal,
  type RegimeTag,
} from "./types";
import {
  calendarDayKey,
  distinctCalendarDays,
  distinctRegimes,
  resolvedTp1Samples,
  sampleIndependenceOk,
} from "./recalibrate";

export function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function avgRealizedRFull(rows: LoggedSignal[]): number | null {
  const closed = rows.filter(
    (s) => s.fullPlanClosed && s.realizedRFull != null && Number.isFinite(s.realizedRFull),
  );
  if (closed.length === 0) return null;
  const sum = closed.reduce((a, s) => a + (s.realizedRFull as number), 0);
  return Math.round((sum / closed.length) * 1000) / 1000;
}

export function bucketRows(
  signals: LoggedSignal[],
  filter?: (s: LoggedSignal) => boolean,
): CalibrationBucketRow[] {
  const resolved = resolvedTp1Samples(signals).filter((s) => !filter || filter(s));

  return CONFIDENCE_BUCKETS.map((b) => {
    const inBucket = resolved.filter(
      (s) => s.confidence >= b.min && s.confidence < b.max,
    );
    const tp = inBucket.filter((s) => s.outcomeTp1 === "WIN").length;
    const sl = inBucket.filter((s) => s.outcomeTp1 === "LOSS").length;
    const n = tp + sl;
    const actual = n > 0 ? (tp / n) * 100 : null;
    const claimedMid = (b.min + b.max) / 2;
    const brierScores = inBucket.map((s) => {
      const p = (s.winChanceDisplayed || claimedMid) / 100;
      return (p - (s.outcomeTp1 === "WIN" ? 1 : 0)) ** 2;
    });
    const brierAvg =
      brierScores.length > 0
        ? Math.round(
            (brierScores.reduce((a, x) => a + x, 0) / brierScores.length) * 10000,
          ) / 10000
        : null;

    return {
      bucket: b.label,
      bucketMin: b.min,
      bucketMax: b.max,
      claimedConfidenceMid: claimedMid,
      actualWinRate: actual != null ? Math.round(actual * 10) / 10 : null,
      sampleSize: n,
      tpHits: tp,
      slHits: sl,
      avgRealizedRFull: avgRealizedRFull(inBucket),
      brierScore: brierAvg,
      untrusted: actual != null && claimedMid - actual > 15,
    };
  });
}

export function printBucketTable(title: string, rows: CalibrationBucketRow[]) {
  console.log(`\n=== ${title} ===`);
  console.log(
    pad("bucket", 10) +
      pad("claimed~", 10) +
      pad("TP1win%", 10) +
      pad("avgR_f", 10) +
      pad("n", 6) +
      pad("Brier", 10) +
      "flag",
  );
  console.log("-".repeat(66));
  for (const r of rows) {
    const actual = r.actualWinRate == null ? "—" : String(r.actualWinRate);
    const avgR = r.avgRealizedRFull == null ? "—" : String(r.avgRealizedRFull);
    const brier = r.brierScore == null ? "—" : String(r.brierScore);
    const flag = r.untrusted ? "⚠ UNTRUSTED (>15pts below claimed)" : "";
    console.log(
      pad(r.bucket, 10) +
        pad(String(r.claimedConfidenceMid), 10) +
        pad(actual, 10) +
        pad(avgR, 10) +
        pad(String(r.sampleSize), 6) +
        pad(brier, 10) +
        flag,
    );
  }
}

export function printRegimeBreakdown(signals: LoggedSignal[]) {
  console.log("\n=== Per-regime (within each confidence bucket) ===");
  const regimes: RegimeTag[] = ["TREND_UP", "TREND_DOWN", "RANGE"];
  const resolved = resolvedTp1Samples(signals);

  for (const b of CONFIDENCE_BUCKETS) {
    const inBucket = resolved.filter(
      (s) => s.confidence >= b.min && s.confidence < b.max,
    );
    if (inBucket.length === 0) continue;

    console.log(`\n  bucket ${b.label} (n=${inBucket.length})`);
    for (const regime of regimes) {
      const rows = inBucket.filter((s) => s.regime === regime);
      if (rows.length === 0) continue;
      const wins = rows.filter((s) => s.outcomeTp1 === "WIN").length;
      const n = rows.length;
      const wr = Math.round((wins / n) * 1000) / 10;
      console.log(`    ${pad(regime, 12)} TP1win%=${pad(String(wr), 6)} n=${n}`);
    }
    const unknown = inBucket.filter((s) => !s.regime);
    if (unknown.length) {
      console.log(`    ${pad("(no tag)", 12)} n=${unknown.length}`);
    }

    const byRegime = regimes.map((r) => inBucket.filter((s) => s.regime === r).length);
    const maxRegime = Math.max(0, ...byRegime);
    if (inBucket.length > 0 && maxRegime / inBucket.length > 0.7) {
      console.log(
        `    ⚠ >70% of this bucket's samples come from a single regime — treat as correlated.`,
      );
    }
    const dayCounts = new Map<string, number>();
    for (const s of inBucket) {
      const d = calendarDayKey(s.resolvedAt ?? s.timestamp);
      dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
    }
    const maxDay = Math.max(0, ...dayCounts.values());
    if (inBucket.length > 0 && maxDay / inBucket.length > 0.7) {
      console.log(
        `    ⚠ >70% of this bucket's samples come from a single calendar day — treat as correlated.`,
      );
    }

    const indep = sampleIndependenceOk(inBucket);
    if (inBucket.length >= MIN_SAMPLES_FOR_CALIBRATION && !indep.ok) {
      console.log(
        `    ⚠ Recal unlock blocked: regimes=${indep.regimeCount} (need ≥${MIN_REGIMES_FOR_CALIBRATION}), ` +
          `days=${indep.calendarDayCount} (need ≥${MIN_CALENDAR_DAYS_FOR_CALIBRATION})`,
      );
    }
  }
}

export function printStandardCalibrationTables(signals: LoggedSignal[]) {
  printBucketTable("All sides / modes", bucketRows(signals));
  printBucketTable("BUY only", bucketRows(signals, (s) => s.side === "BUY"));
  printBucketTable("SELL only", bucketRows(signals, (s) => s.side === "SELL"));
  printBucketTable("Scalping", bucketRows(signals, (s) => s.mode === "scalping"));
  printBucketTable("Intraday", bucketRows(signals, (s) => s.mode === "intraday"));
  printBucketTable(
    "Conflict-capped only",
    bucketRows(signals, (s) => s.conflictCapped),
  );
  printRegimeBreakdown(signals);

  const untrusted = bucketRows(signals).filter((r) => r.untrusted);
  if (untrusted.length) {
    console.log("\n⚠ Buckets where TP1 win rate is >15 points below claimed mid:");
    for (const u of untrusted) {
      console.log(
        `  - ${u.bucket}: claimed~${u.claimedConfidenceMid}% TP1win=${u.actualWinRate}% n=${u.sampleSize} avgR_full=${u.avgRealizedRFull ?? "—"}`,
      );
    }
    console.log(
      "  → Do not trust / display these as high-confidence until recalibrated.\n",
    );
  } else {
    console.log("\nNo untrusted buckets in this window (or insufficient samples).\n");
  }

  return {
    resolved: resolvedTp1Samples(signals),
    regimes: distinctRegimes(resolvedTp1Samples(signals)),
    calendarDays: distinctCalendarDays(resolvedTp1Samples(signals)).length,
    overallWinRate: (() => {
      const r = resolvedTp1Samples(signals);
      const w = r.filter((s) => s.outcomeTp1 === "WIN").length;
      return r.length ? (w / r.length) * 100 : null;
    })(),
    avgRFull: avgRealizedRFull(signals),
  };
}
