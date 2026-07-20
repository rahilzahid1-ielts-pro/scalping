/**
 * Genuine multi-module backtest on local MT5 XAU CSV (no tempering).
 * Uses production engines + same spread defaults as daemon/backtest.
 *
 *   npx tsx scripts/backtestAllCsv.ts [--days=365] [--spread=0.25]
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { loadHistoricalFile, filterLastDays, windowStartIndex } from "../src/backtest/loadData";
import {
  closeBacktestDb,
  getBacktestDbPath,
  openBacktestDb,
} from "../src/backtest/store";
import { maxDrawdownR, runWalkForward } from "../src/backtest/engine";
import { runQuickScalpBacktest } from "../src/quickScalp/backtest";
import { runProBacktest } from "../src/pro/backtest";
import { runCompareStrategyBacktest } from "../src/strategyCompare/backtest";
import type { TradeMode } from "../src/types";

const M5 = "data/XAU_5m_data.csv";
const OUT = "data/_csv_backtest_all_modules.json";

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

type Row = {
  module: string;
  mode?: string;
  signals: number;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  maxDrawdownR: number | null;
  openLeft: number;
  elapsedSec: number;
  notes: string;
  /** Main desk only: zone-touch funnel extras */
  zoneTouched?: number;
};

function resetMainBtDb() {
  closeBacktestDb();
  const dbPath = getBacktestDbPath();
  for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
  return openBacktestDb(true);
}

function main() {
  const days = Number(argValue(process.argv.slice(2), "--days") ?? 365);
  const spread = Number(argValue(process.argv.slice(2), "--spread") ?? 0.25);

  console.log(`Loading ${M5} …`);
  const tLoad = Date.now();
  const loaded = loadHistoricalFile(M5);
  console.log(
    `Loaded ${loaded.quality.bars} M5 bars in ${((Date.now() - tLoad) / 1000).toFixed(1)}s`,
  );
  console.log(`Range: ${loaded.quality.firstIso} → ${loaded.quality.lastIso}`);
  console.log(`Period: ${loaded.quality.periodMinutes}m`);
  console.log(`Window: last ${days}d · spread=${spread}`);
  console.log(
    `Method: HTF resampled from M5 only (prod parity). Other CSV TFs not mixed. No param tuning.\n`,
  );

  if (loaded.quality.periodMinutes !== 5) {
    console.warn(
      `⚠ Inferred period=${loaded.quality.periodMinutes}m — expected 5. Check CSV.`,
    );
  }

  // Slice to warmup+window so we don't walk 20y of idle bars (same 365d results).
  const candles = filterLastDays(loaded.candles, days);
  const winStart = windowStartIndex(candles, days);
  console.log(
    `Sliced to ${candles.length} bars (warmup+${days}d) · window idx ${winStart} (${new Date(candles[winStart]?.time ?? 0).toISOString()})\n`,
  );

  const rows: Row[] = [];

  function add(row: Row) {
    rows.push(row);
    const wr = row.winRate == null ? "n/a" : `${row.winRate.toFixed(1)}%`;
    const avg = row.avgR == null ? "n/a" : row.avgR.toFixed(3);
    console.log(
      `✓ ${row.module}${row.mode ? `/${row.mode}` : ""}  n=${row.resolved}  wr=${wr}  avgR=${avg}  ` +
        `signals=${row.signals}  (${row.elapsedSec.toFixed(1)}s)`,
    );
  }

  // --- Main Scalp + Intraday (session-lock walk-forward) ---
  for (const mode of ["scalping", "intraday"] as TradeMode[]) {
    const t0 = Date.now();
    console.log(`\nRunning main ${mode}…`);
    const db = resetMainBtDb();
    const stats = runWalkForward(db, candles, {
      assetId: "XAUUSD",
      modes: [mode],
      spread,
      windowStartIdx: winStart,
      trendConfirmBars: mode === "scalping" ? 4 : undefined,
      onProgress: (done, total) => {
        if (done === 0 || done === total || done % 5000 === 0) {
          process.stdout.write(
            `\r  progress ${done}/${total} (${((done / total) * 100).toFixed(0)}%)   `,
          );
        }
      },
    });
    process.stdout.write("\n");
    closeBacktestDb();

    const wins = stats.tp1WinsAfterTouch;
    const losses = stats.tp1LossesAfterTouch;
    const resolved = wins + losses;
    const winRate = resolved > 0 ? (wins / resolved) * 100 : null;
    const lastEq =
      stats.equityR.length > 0 ? stats.equityR[stats.equityR.length - 1] : 0;
    const avgR = resolved > 0 ? lastEq / resolved : null;
    const maxDd = maxDrawdownR(stats.equityR);

    add({
      module: "main",
      mode,
      signals: stats.signalsFired,
      resolved,
      wins,
      losses,
      winRate,
      avgR,
      maxDrawdownR: maxDd,
      openLeft: Math.max(0, stats.signalsFired - stats.zoneTouched),
      zoneTouched: stats.zoneTouched,
      elapsedSec: (Date.now() - t0) / 1000,
      notes:
        "Session-lock funnel: winRate = TP1 among zone-touched+resolved (live desk path)",
    });
  }

  // --- Quick Scalp BLITZ ---
  {
    const t0 = Date.now();
    console.log(`\nRunning quick_scalp…`);
    const stats = runQuickScalpBacktest({
      candles,
      days,
      spread,
      symbol: "XAUUSD",
    });
    add({
      module: "quick_scalp",
      ...stats,
      elapsedSec: (Date.now() - t0) / 1000,
      notes: "SMC scalping + conf≥75 + HTF + trend + daily · TP1@0.85R",
    });
  }

  // --- Pro ---
  {
    const t0 = Date.now();
    console.log(`\nRunning pro…`);
    const stats = runProBacktest({
      candles,
      days,
      spread,
      symbol: "XAUUSD",
    });
    add({
      module: "pro",
      ...stats,
      elapsedSec: (Date.now() - t0) / 1000,
      notes: "SMC intraday + conf≥80 + HTF + trend + daily",
    });
  }

  // --- Cipher B / Fractal ---
  for (const strategy of ["cipher_b_clone", "fractal"] as const) {
    const t0 = Date.now();
    console.log(`\nRunning ${strategy}…`);
    const stats = runCompareStrategyBacktest({
      candles,
      strategy,
      days,
      spread,
      symbol: "XAUUSD",
    });
    add({
      module: strategy,
      ...stats,
      elapsedSec: (Date.now() - t0) / 1000,
      notes:
        strategy === "fractal"
          ? "Fractal breakout MUST agree with SMC gates"
          : "Cipher B trigger MUST agree with SMC gates",
    });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: M5,
    days,
    spread,
    tempered: false,
    data: {
      bars: loaded.quality.bars,
      firstIso: loaded.quality.firstIso,
      lastIso: loaded.quality.lastIso,
      periodMinutes: loaded.quality.periodMinutes,
      duplicates: loaded.quality.duplicates,
      nonMonotonic: loaded.quality.nonMonotonic,
      suspiciousGaps: loaded.quality.suspiciousGaps,
    },
    method:
      "Walk-forward on XAU_5m_data.csv; HTF from M5 aggregation; spread applied at entry; production engines; no parameter search / no cherry-pick.",
    results: rows,
  };

  writeFileSync(OUT, JSON.stringify(payload, null, 2), "utf8");
  console.log(`\nWrote ${OUT}`);
  console.log("\n=== SUMMARY (genuine, untuned) ===");
  for (const r of rows) {
    console.log(
      [
        r.module.padEnd(16),
        (r.mode ?? "-").padEnd(10),
        `n=${String(r.resolved).padStart(5)}`,
        `wr=${r.winRate == null ? "  n/a" : r.winRate.toFixed(1).padStart(5) + "%"}`,
        `avgR=${r.avgR == null ? "  n/a" : r.avgR.toFixed(3).padStart(6)}`,
        `dd=${r.maxDrawdownR == null ? " n/a" : r.maxDrawdownR.toFixed(1).padStart(5)}`,
        `sig=${r.signals}`,
      ].join("  "),
    );
  }
}

main();
