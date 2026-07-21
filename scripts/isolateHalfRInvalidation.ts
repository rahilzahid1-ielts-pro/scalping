/**
 * Isolate Main Scalp session-lock degradation:
 *   A) pre-hotfix waiting invalidation (legacy nested) — no reject-missed
 *   B) legacy nested + reject-missed at lock only
 *   C) current prod: half-R immediate waiting invalidation + reject-missed
 *
 *   npx tsx scripts/isolateHalfRInvalidation.ts
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { loadHistoricalFile, windowStartIndex } from "../src/backtest/loadData";
import {
  closeBacktestDb,
  getBacktestDbPath,
  listBacktestSignals,
  openBacktestDb,
} from "../src/backtest/store";
import {
  conditionalTp1WinRate,
  longestLosingStreak,
  maxDrawdownR,
  runWalkForward,
  zoneTouchRate,
} from "../src/backtest/engine";
import {
  setWaitingTooLateMode,
  type WaitingTooLateMode,
} from "../src/services/tradePlan";

const FILE = "C:/scalping/data/XAUUSD_M5.json";
const OUT = "data/_isolate_half_r_invalidation.json";
const SPREAD = 0.25;
const DAYS = 365;

type Variant = {
  id: string;
  label: string;
  waitingMode: WaitingTooLateMode;
  rejectAlreadyMissed: boolean;
};

const VARIANTS: Variant[] = [
  {
    id: "A",
    label: "A) Pre-hotfix (legacy nested, no reject-missed)",
    waitingMode: "legacy_nested",
    rejectAlreadyMissed: false,
  },
  {
    id: "B",
    label: "B) Reject-missed only (legacy nested, no 0.5R wait-invalidate)",
    waitingMode: "legacy_nested",
    rejectAlreadyMissed: true,
  },
  {
    id: "C",
    label: "C) Current prod (0.5R wait-invalidate + reject-missed)",
    waitingMode: "half_r_immediate",
    rejectAlreadyMissed: true,
  },
];

function resetDb() {
  closeBacktestDb();
  const p = getBacktestDbPath();
  for (const f of [p, p + "-wal", p + "-shm"]) {
    if (existsSync(f)) {
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
  return openBacktestDb(true);
}

function runVariant(
  v: Variant,
  candles: ReturnType<typeof loadHistoricalFile>["candles"],
  windowStartIdx: number,
) {
  setWaitingTooLateMode(v.waitingMode);
  const db = resetDb();
  const t0 = Date.now();
  const stats = runWalkForward(db, candles, {
    assetId: "XAUUSD",
    modes: ["scalping"],
    spread: SPREAD,
    windowStartIdx,
    trendConfirmBars: 4,
    rejectAlreadyMissed: v.rejectAlreadyMissed,
    onProgress: (done, total) => {
      if (done === 0 || done === total || done % 10000 === 0) {
        process.stdout.write(
          `\r  ${v.id} ${done}/${total} (${((done / total) * 100).toFixed(0)}%)   `,
        );
      }
    },
  });
  process.stdout.write("\n");

  const signals = listBacktestSignals(db);
  const touched = signals.filter((s) => s.zoneTouchedAt != null);
  const resolved = touched.filter(
    (s) => s.outcomeTp1 === "WIN" || s.outcomeTp1 === "LOSS",
  );
  const avgR = (() => {
    const closed = touched.filter(
      (s) => s.fullPlanClosed && s.realizedRFull != null,
    );
    if (!closed.length) return null;
    return (
      closed.reduce((a, s) => a + (s.realizedRFull as number), 0) / closed.length
    );
  })();

  const row = {
    id: v.id,
    label: v.label,
    waitingMode: v.waitingMode,
    rejectAlreadyMissed: v.rejectAlreadyMissed,
    locked: stats.signalsFired,
    zoneTouchPct: zoneTouchRate(stats),
    executedN: resolved.length,
    winRate: conditionalTp1WinRate(stats),
    avgR,
    maxDrawdownR: maxDrawdownR(stats.equityR),
    longestLosingStreak: longestLosingStreak(signals),
    tp1Wins: stats.tp1WinsAfterTouch,
    tp1Losses: stats.tp1LossesAfterTouch,
    elapsedSec: (Date.now() - t0) / 1000,
  };

  const zt = row.zoneTouchPct == null ? "n/a" : `${row.zoneTouchPct.toFixed(1)}%`;
  const wr = row.winRate == null ? "n/a" : `${row.winRate.toFixed(1)}%`;
  const ar =
    row.avgR == null ? "n/a" : `${row.avgR >= 0 ? "+" : ""}${row.avgR.toFixed(3)}R`;
  console.log(
    `${v.id} locked=${row.locked} touch=${zt} n=${row.executedN} WR=${wr} avgR=${ar} maxDD=${row.maxDrawdownR}`,
  );
  return row;
}

function main() {
  console.log(`Loading ${FILE}…`);
  const loaded = loadHistoricalFile(FILE);
  const winStart = windowStartIndex(loaded.candles, DAYS);
  console.log(
    `Main Scalp isolation · session-lock · spread=${SPREAD} · days=${DAYS} · start=${new Date(loaded.candles[winStart]?.time ?? 0).toISOString()}\n`,
  );

  const results = [];
  try {
    for (const v of VARIANTS) {
      console.log(`\n======== ${v.label} ========`);
      results.push(runVariant(v, loaded.candles, winStart));
    }
  } finally {
    // Production default after confirmed revert of half-R wait-invalidation.
    setWaitingTooLateMode("legacy_nested");
  }

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        file: FILE,
        days: DAYS,
        spread: SPREAD,
        mode: "scalping",
        note: "real-locks-only logging does not affect this walk-forward pipeline",
        results,
      },
      null,
      2,
    ),
  );

  console.log("\n======== SIDE-BY-SIDE ========");
  console.log(
    "Variant | Locked | Touch% | Exec n | Win% | Avg R | MaxDD",
  );
  for (const r of results) {
    const zt =
      r.zoneTouchPct == null ? "n/a" : `${r.zoneTouchPct.toFixed(1)}%`;
    const wr = r.winRate == null ? "n/a" : `${r.winRate.toFixed(1)}%`;
    const ar =
      r.avgR == null ? "n/a" : `${r.avgR >= 0 ? "+" : ""}${r.avgR.toFixed(3)}`;
    console.log(
      `${r.id} | ${r.locked} | ${zt} | ${r.executedN} | ${wr} | ${ar} | ${r.maxDrawdownR}`,
    );
  }
  console.log(`\nWrote ${OUT}`);
}

main();
