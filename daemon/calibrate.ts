/**
 * CLI: npm run calibrate -- [--days=30]
 * Prints TP1 win rate (primary) + avg full-plan R by confidence bucket / side / mode / regime.
 */
import {
  CONFIDENCE_BUCKETS,
  MIN_CALENDAR_DAYS_FOR_CALIBRATION,
  MIN_DAYS_BEFORE_DISPLAY_RECAL,
  MIN_REGIMES_FOR_CALIBRATION,
  MIN_SAMPLES_FOR_CALIBRATION,
  type CalibrationBucketRow,
  type LoggedSignal,
  type RegimeTag,
} from "../src/calibration/types";
import {
  SIGNAL_DB_PATH,
  ensureDbMigrated,
  listAllSignals,
} from "../src/calibration/db";
import {
  calendarDayKey,
  calibrationDisplayGateOk,
  distinctCalendarDays,
  distinctRegimes,
  resolvedTp1Samples,
  sampleIndependenceOk,
} from "../src/calibration/recalibrate";

function parseDays(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith("--days="));
  if (!arg) return 30;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function pad(s: string, n: number) {
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

function bucketRows(
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

function printTable(title: string, rows: CalibrationBucketRow[]) {
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

function printRegimeBreakdown(signals: LoggedSignal[]) {
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
      console.log(
        `    ${pad(regime, 12)} TP1win%=${pad(String(wr), 6)} n=${n}`,
      );
    }
    const unknown = inBucket.filter((s) => !s.regime);
    if (unknown.length) {
      console.log(`    ${pad("(no tag)", 12)} n=${unknown.length}`);
    }

    // Concentration warnings
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

function main() {
  const days = parseDays(process.argv.slice(2));
  const migration = ensureDbMigrated();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = listAllSignals();
  const signals = all.filter((s) => s.timestamp >= cutoff);
  const resolved = resolvedTp1Samples(signals);

  console.log(`
SMC Calibration Report
──────────────────────
Store   : ${SIGNAL_DB_PATH}
Migration: imported=${migration.imported} skipped=${migration.skipped}${migration.alreadyMigrated ? " (already migrated)" : ""}
Window  : last ${days} days
Total rows in window: ${signals.length}
TP1 resolved (WIN|LOSS): ${resolved.length}
  WIN=${resolved.filter((s) => s.outcomeTp1 === "WIN").length}  LOSS=${resolved.filter((s) => s.outcomeTp1 === "LOSS").length}
Open (pre-TP1)        : ${signals.filter((s) => s.outcome === "OPEN").length}
Post-TP1 tracking     : ${signals.filter((s) => s.outcomeTp1 === "WIN" && !s.fullPlanClosed).length}
Full-plan closed      : ${signals.filter((s) => s.fullPlanClosed).length}
Invalidated           : ${signals.filter((s) => s.outcome === "INVALIDATED").length}
Regimes in window     : ${distinctRegimes(resolved).join(", ") || "(none)"}
Calendar days (TP1)   : ${distinctCalendarDays(resolved).length}
Display recal gate    : ${calibrationDisplayGateOk(all) ? "OPEN (≥14d data)" : `CLOSED (need ≥${MIN_DAYS_BEFORE_DISPLAY_RECAL}d resolved history)`}
Bucket unlock needs   : n≥${MIN_SAMPLES_FOR_CALIBRATION}, regimes≥${MIN_REGIMES_FOR_CALIBRATION}, days≥${MIN_CALENDAR_DAYS_FOR_CALIBRATION}, age≥${MIN_DAYS_BEFORE_DISPLAY_RECAL}d
`);

  printTable("All sides / modes", bucketRows(signals));
  printTable("BUY only", bucketRows(signals, (s) => s.side === "BUY"));
  printTable("SELL only", bucketRows(signals, (s) => s.side === "SELL"));
  printTable("Scalping", bucketRows(signals, (s) => s.mode === "scalping"));
  printTable("Intraday", bucketRows(signals, (s) => s.mode === "intraday"));
  printTable(
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

  console.log(`How to read this report:
  • claimed~     = midpoint of the confidence score bucket (formula output, NOT probability)
  • TP1win%      = outcomeTp1 WIN / (WIN + LOSS) — PRIMARY metric (what card "win chance" claims)
  • avgR_f       = average realizedR_full for fullPlanClosed rows (1/3 @ each TP; SL→entry after TP1)
  • Brier        = MSE of displayed winChance vs TP1 WIN/LOSS (lower is better; 0 = perfect)
  • UNTRUSTED    = TP1win% is >15 points worse than claimed mid
  • Display win% stays raw until ≥${MIN_DAYS_BEFORE_DISPLAY_RECAL}d + n≥${MIN_SAMPLES_FOR_CALIBRATION}
    + ≥${MIN_REGIMES_FOR_CALIBRATION} regimes + ≥${MIN_CALENDAR_DAYS_FOR_CALIBRATION} calendar days in the bucket.
`);
}

main();
