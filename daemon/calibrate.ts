/**
 * CLI: npm run calibrate -- [--days=30]
 * Prints TP1 win rate (primary) + avg full-plan R by confidence bucket / side / mode / regime.
 */
import {
  MIN_CALENDAR_DAYS_FOR_CALIBRATION,
  MIN_DAYS_BEFORE_DISPLAY_RECAL,
  MIN_REGIMES_FOR_CALIBRATION,
  MIN_SAMPLES_FOR_CALIBRATION,
} from "../src/calibration/types";
import {
  SIGNAL_DB_PATH,
  ensureDbMigrated,
  listAllSignals,
} from "../src/calibration/db";
import {
  calibrationDisplayGateOk,
  distinctCalendarDays,
  distinctRegimes,
  resolvedTp1Samples,
} from "../src/calibration/recalibrate";
import { printStandardCalibrationTables } from "../src/calibration/report";

function parseDays(argv: string[]): number {
  const arg = argv.find((a) => a.startsWith("--days="));
  if (!arg) return 30;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function main() {
  const days = parseDays(process.argv.slice(2));
  const migration = ensureDbMigrated();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = listAllSignals();
  const signals = all.filter((s) => s.timestamp >= cutoff);
  const resolved = resolvedTp1Samples(signals);

  console.log(`
SMC Calibration Report (LIVE)
─────────────────────────────
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

  printStandardCalibrationTables(signals);

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
