/**
 * CLI: npm run calibrate -- [--days=30] [--module=main]
 *
 * Modules (isolated live tables in data/signals.db):
 *   main | scalp | intraday | quick_scalp | pro | qs_pro |
 *   ttrades_fractal | cipher_b | intra30
 *
 * Prints TP1 win rate (primary) + avg full-plan R by confidence bucket / side / regime.
 * Gates unchanged: ≥14d / n≥50 / regimes / calendar days (see types.ts).
 */
import {
  MIN_CALENDAR_DAYS_FOR_CALIBRATION,
  MIN_DAYS_BEFORE_DISPLAY_RECAL,
  MIN_REGIMES_FOR_CALIBRATION,
  MIN_SAMPLES_FOR_CALIBRATION,
} from "../src/calibration/types";
import { ensureDbMigrated } from "../src/calibration/db";
import {
  calibrationDisplayGateOk,
  distinctCalendarDays,
  distinctRegimes,
  resolvedTp1Samples,
} from "../src/calibration/recalibrate";
import { printStandardCalibrationTables } from "../src/calibration/report";
import {
  CALIBRATE_MODULE_HELP,
  loadModuleSignals,
  parseCalibrateModule,
} from "../src/calibration/moduleSources";

function parseDays(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith("--days="));
  if (!arg) return 30;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: npm run calibrate -- [--days=30] [--module=<id>]
${CALIBRATE_MODULE_HELP}`);
    return;
  }

  const days = parseDays(argv);
  let moduleId;
  try {
    moduleId = parseCalibrateModule(argv);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
    return;
  }

  const migration = ensureDbMigrated();
  const loaded = loadModuleSignals(moduleId);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = loaded.signals;
  const signals = all.filter((s) => s.timestamp >= cutoff);
  const resolved = resolvedTp1Samples(signals);

  const flips = signals.filter((s) => s.outcome === "REGIME_FLIP_INVALIDATED");
  const flipRate = signals.length > 0 ? (flips.length / signals.length) * 100 : 0;
  const flipSaved = flips.filter((s) => s.wouldHaveHitSlFirst === true).length;
  const flipCutWin = flips.filter((s) => s.wouldHaveHitSlFirst === false).length;
  const flipPending = flips.filter((s) => s.wouldHaveHitSlFirst == null).length;
  const flipDetermined = flipSaved + flipCutWin;
  const savedPct = flipDetermined > 0 ? (flipSaved / flipDetermined) * 100 : null;

  const tp1WinRate = (arr: typeof resolved): number | null => {
    const w = arr.filter((s) => s.outcomeTp1 === "WIN").length;
    return arr.length > 0 ? (w / arr.length) * 100 : null;
  };
  const swept = resolved.filter((s) => s.liquiditySweepDetectedAt != null);
  const noSweep = resolved.filter((s) => s.liquiditySweepDetectedAt == null);
  const sweptWr = tp1WinRate(swept);
  const noSweepWr = tp1WinRate(noSweep);
  const sweptTotal = signals.filter((s) => s.liquiditySweepDetectedAt != null).length;
  const fmtWr = (v: number | null) => (v == null ? "n/a" : `${v.toFixed(1)}%`);
  const wrDelta =
    sweptWr != null && noSweepWr != null
      ? `${(sweptWr - noSweepWr >= 0 ? "+" : "")}${(sweptWr - noSweepWr).toFixed(1)}pts`
      : "n/a";

  const scalpResolved = resolved.filter((s) => s.mode === "scalping");
  const tcResolved = scalpResolved.filter((s) => s.trendConfirmedAt != null);
  const ntResolved = scalpResolved.filter((s) => s.trendConfirmedAt == null);
  const tcWr = tp1WinRate(tcResolved);
  const ntWr = tp1WinRate(ntResolved);
  const tcWrDelta =
    tcWr != null && ntWr != null
      ? `${tcWr - ntWr >= 0 ? "+" : ""}${(tcWr - ntWr).toFixed(1)}pts`
      : "n/a";
  const trendDurs = signals
    .filter((s) => s.mode === "scalping" && s.trendDurationBars != null)
    .map((s) => s.trendDurationBars as number);
  const avgTrendDur =
    trendDurs.length > 0
      ? trendDurs.reduce((a, b) => a + b, 0) / trendDurs.length
      : null;
  const trendConfirmedTotal = signals.filter(
    (s) => s.mode === "scalping" && s.trendConfirmedAt != null,
  ).length;

  const isMainFamily =
    moduleId === "main" || moduleId === "scalp" || moduleId === "intraday";

  console.log(`
SMC Calibration Report (LIVE)
─────────────────────────────
Module  : ${moduleId}
Store   : ${loaded.storeLabel}
Table rows (all-time live): ${loaded.tableRowCount}
Migration: imported=${migration.imported} skipped=${migration.skipped}${migration.alreadyMigrated ? " (already migrated)" : ""}
Window  : last ${days} days
Total rows in window: ${signals.length}
TP1 resolved (WIN|LOSS): ${resolved.length}
  WIN=${resolved.filter((s) => s.outcomeTp1 === "WIN").length}  LOSS=${resolved.filter((s) => s.outcomeTp1 === "LOSS").length}
Open (pre-TP1)        : ${signals.filter((s) => s.outcome === "OPEN").length}
Post-TP1 tracking     : ${signals.filter((s) => s.outcomeTp1 === "WIN" && !s.fullPlanClosed).length}
Full-plan closed      : ${signals.filter((s) => s.fullPlanClosed).length}
Invalidated           : ${signals.filter((s) => s.outcome === "INVALIDATED").length}
Regime-flip invalidated: ${flips.length} (${flipRate.toFixed(1)}% of locked plans)
  wouldHaveHitSlFirst  : true=${flipSaved} (saved loss)  false=${flipCutWin} (cut a win)  pending=${flipPending}
  → saved-loss rate    : ${savedPct == null ? "n/a (none resolved yet)" : `${savedPct.toFixed(1)}% of ${flipDetermined} resolved flips`}
Tier-1 liquidity sweep (mid-plan warning): ${sweptTotal} plans flagged
  TP1win% with sweep   : ${fmtWr(sweptWr)} (n=${swept.length})
  TP1win% no sweep     : ${fmtWr(noSweepWr)} (n=${noSweep.length})
  → predictive delta   : ${wrDelta} ${sweptWr != null && noSweepWr != null ? (sweptWr < noSweepWr - 5 ? "(sweep worse → warning predictive)" : "(similar → penalty may be noise)") : ""}
${
  isMainFamily
    ? `Trend-confirmation (scalping-only): ${trendConfirmedTotal} plans trend-confirmed
  Avg trend duration   : ${avgTrendDur == null ? "n/a" : `${avgTrendDur.toFixed(1)} bars`} (n=${trendDurs.length} completed runs)
  TP1win% confirmed    : ${fmtWr(tcWr)} (n=${tcResolved.length})
  TP1win% other scalps : ${fmtWr(ntWr)} (n=${ntResolved.length})
  → trend-window edge  : ${tcWrDelta}`
    : `Trend-confirmation : n/a (module table — main scalping fields only)`
}
Regimes in window     : ${distinctRegimes(resolved).join(", ") || "(none)"}
Calendar days (TP1)   : ${distinctCalendarDays(resolved).length}
Display recal gate    : ${calibrationDisplayGateOk(all) ? "OPEN (≥14d data)" : `CLOSED (need ≥${MIN_DAYS_BEFORE_DISPLAY_RECAL}d resolved history)`}
Bucket unlock needs   : n≥${MIN_SAMPLES_FOR_CALIBRATION}, regimes≥${MIN_REGIMES_FOR_CALIBRATION}, days≥${MIN_CALENDAR_DAYS_FOR_CALIBRATION}, age≥${MIN_DAYS_BEFORE_DISPLAY_RECAL}d
`);

  printStandardCalibrationTables(signals);

  console.log(`How to read this report:
  • claimed~     = midpoint of the confidence score bucket (formula output, NOT probability)
  • TP1win%      = outcomeTp1 WIN / (WIN + LOSS) — PRIMARY metric (what card "win chance" claims)
  • avgR_f       = average realizedR_full for fullPlanClosed rows (1/3 @ each TP; SL→entry after TP1)
  • Brier        = MSE of displayed winChance vs TP1 WIN/LOSS (lower is better; 0 = perfect)
  • UNTRUSTED    = TP1win% is >15 points worse than claimed mid
  • Display win% stays raw until ≥${MIN_DAYS_BEFORE_DISPLAY_RECAL}d + n≥${MIN_SAMPLES_FOR_CALIBRATION}
    + ≥${MIN_REGIMES_FOR_CALIBRATION} regimes + ≥${MIN_CALENDAR_DAYS_FOR_CALIBRATION} calendar days in the bucket.
  • Module tables without a confidence column use conf parsed from reason text (else 0).
`);
}

main();
