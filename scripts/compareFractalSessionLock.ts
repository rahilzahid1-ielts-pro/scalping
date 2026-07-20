/**
 * Session-lock apples-to-apples: main SMC baseline vs fractal-agree-only gate.
 * Same runWalkForward pipeline as daemon/backtest.ts (canAutoLockPlan / createFrozenPlan).
 *
 *   npx tsx scripts/compareFractalSessionLock.ts
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { loadHistoricalFile } from "../src/backtest/loadData";
import {
  closeBacktestDb,
  getBacktestDbPath,
  listBacktestSignals,
  openBacktestDb,
} from "../src/backtest/store";
import {
  conditionalTp1WinRate,
  maxDrawdownR,
  runWalkForward,
  zoneTouchRate,
  type BacktestStats,
} from "../src/backtest/engine";
import type { Candle } from "../src/types";

const M5 = "data/XAU_5m_data.csv";
const OUT = "data/_fractal_session_lock_compare.json";
const SPREAD = 0.25;
const WARMUP_MS = 120 * 24 * 60 * 60 * 1000;

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

function sliceWindow(all: Candle[], startIso: string, endIso: string) {
  const windowStartMs = Date.parse(startIso);
  const windowEndMs = Date.parse(endIso);
  const candles = all.filter(
    (c) => c.time >= windowStartMs - WARMUP_MS && c.time <= windowEndMs,
  );
  const windowStartIdx = candles.findIndex((c) => c.time >= windowStartMs);
  if (windowStartIdx < 0) throw new Error(`No bars in window ${startIso}`);
  return { candles, windowStartIdx, windowStartMs, windowEndMs };
}

function report(label: string, stats: BacktestStats) {
  const db = openBacktestDb(false);
  const signals = listBacktestSignals(db);
  const touched = signals.filter((s) => s.zoneTouchedAt != null);
  const resolvedTp1 = touched.filter(
    (s) => s.outcomeTp1 === "WIN" || s.outcomeTp1 === "LOSS",
  );
  const avgRTouch = (() => {
    // Prefer full-plan R when closed; else TP1 realizedR for touched resolves
    const withR = resolvedTp1.filter((s) => s.realizedR != null);
    if (!withR.length) return null;
    return withR.reduce((a, s) => a + (s.realizedR as number), 0) / withR.length;
  })();
  const avgRFull = (() => {
    const closed = touched.filter(
      (s) => s.fullPlanClosed && s.realizedRFull != null,
    );
    if (!closed.length) return null;
    return (
      closed.reduce((a, s) => a + (s.realizedRFull as number), 0) / closed.length
    );
  })();

  const zoneTouchPct = zoneTouchRate(stats);
  const condTp1Pct = conditionalTp1WinRate(stats);
  const row = {
    label,
    locked: stats.signalsFired,
    zoneTouched: stats.zoneTouched,
    zoneTouchPct,
    tp1Wins: stats.tp1WinsAfterTouch,
    tp1Losses: stats.tp1LossesAfterTouch,
    conditionalTp1Pct: condTp1Pct,
    avgR_tp1Touched: avgRTouch,
    avgR_fullPlanClosed: avgRFull,
    maxDrawdownR: maxDrawdownR(stats.equityR),
  };

  const zt = zoneTouchPct == null ? "n/a" : `${zoneTouchPct.toFixed(1)}%`;
  const ct = condTp1Pct == null ? "n/a" : `${condTp1Pct.toFixed(1)}%`;
  const ar =
    avgRTouch == null ? "n/a" : `${avgRTouch >= 0 ? "+" : ""}${avgRTouch.toFixed(3)}R`;
  console.log(
    `${label.padEnd(28)} locked=${String(stats.signalsFired).padStart(4)}  ` +
      `zoneTouch=${zt.padStart(6)}  condTP1=${ct.padStart(6)}  avgR(tp1)=${ar}`,
  );
  return row;
}

function runOne(
  label: string,
  candles: Candle[],
  windowStartIdx: number,
  requireFractalAgree: boolean,
) {
  const db = resetDb();
  const t0 = Date.now();
  const stats = runWalkForward(db, candles, {
    assetId: "XAUUSD",
    modes: ["scalping"],
    spread: SPREAD,
    windowStartIdx,
    trendConfirmBars: 4,
    requireFractalAgree,
    onProgress: (done, total) => {
      if (done === 0 || done === total || done % 10000 === 0) {
        process.stdout.write(
          `\r  ${label} ${done}/${total} (${((done / total) * 100).toFixed(0)}%)   `,
        );
      }
    },
  });
  process.stdout.write("\n");
  console.log(`  elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return report(label, stats);
}

function main() {
  console.log(`Loading ${M5}…`);
  const all = loadHistoricalFile(M5).candles;
  console.log(
    `Session-lock WF · scalping · spread=${SPREAD} · trendConfirmBars=4`,
  );
  console.log(
    `Baseline = main canAutoLockPlan path; Fractal = same + requireFractalAgree\n`,
  );

  const windows = [
    {
      name: "PRIMARY",
      start: "2025-01-30T23:55:00.000Z",
      end: "2026-01-30T23:55:00.000Z",
    },
    {
      name: "ROBUSTNESS",
      start: "2024-01-30T23:55:00.000Z",
      end: "2025-01-30T23:55:00.000Z",
    },
  ] as const;

  const results: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    method:
      "runWalkForward session-lock (same as daemon/backtest.ts). Scalping only. Fractal variant adds requireFractalAgree after canAutoLockPlan — SMC levels unchanged.",
    spread: SPREAD,
    note: "Trusted JSON baseline (292/69.2%/59.9%/+0.341R) was a different file/window; compare rows within THIS CSV apples-to-apples.",
  };

  for (const w of windows) {
    console.log(`\n======== ${w.name} ${w.start.slice(0, 10)} → ${w.end.slice(0, 10)} ========`);
    const { candles, windowStartIdx } = sliceWindow(all, w.start, w.end);
    console.log(`bars=${candles.length} windowStartIdx=${windowStartIdx}`);

    const baseline = runOne(
      `${w.name} baseline SMC`,
      candles,
      windowStartIdx,
      false,
    );
    const fractal = runOne(
      `${w.name} fractal-agree`,
      candles,
      windowStartIdx,
      true,
    );
    results[w.name] = { window: w, baseline, fractalAgreeOnly: fractal };
  }

  writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nWrote ${OUT}`);

  console.log("\n======== TRUSTED-FORMAT TABLE ========");
  console.log(
    "Variant                         | Locked | Zone-touch% | Cond TP1% | avgR (TP1 touched)",
  );
  console.log(
    "---------------------------------|--------|-------------|-----------|--------------------",
  );
  for (const w of windows) {
    const block = results[w.name] as {
      baseline: ReturnType<typeof report>;
      fractalAgreeOnly: ReturnType<typeof report>;
    };
    for (const r of [block.baseline, block.fractalAgreeOnly]) {
      const zt =
        r.zoneTouchPct == null ? "n/a" : `${r.zoneTouchPct.toFixed(1)}%`;
      const ct =
        r.conditionalTp1Pct == null
          ? "n/a"
          : `${r.conditionalTp1Pct.toFixed(1)}%`;
      const ar =
        r.avgR_tp1Touched == null
          ? "n/a"
          : `${r.avgR_tp1Touched >= 0 ? "+" : ""}${r.avgR_tp1Touched.toFixed(3)}`;
      console.log(
        `${r.label.padEnd(32)} | ${String(r.locked).padStart(6)} | ${zt.padStart(11)} | ${ct.padStart(9)} | ${ar.padStart(18)}`,
      );
    }
  }
}

main();
