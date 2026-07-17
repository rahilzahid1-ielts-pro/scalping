/**
 * CLI: npm run backtest -- --file=<path> [--days=365] [--spread=0.25] [--mode=both]
 *
 * Runs production `generateSignal` walk-forward on historical M5 (ForexSB JSON).
 * Results go to data/backtest-results.db — NEVER merges into live signals.db.
 */
import { unlinkSync, existsSync } from "node:fs";
import type { AssetId, TradeMode } from "../src/types";
import { MIN_DAYS_BEFORE_DISPLAY_RECAL, MIN_SAMPLES_FOR_CALIBRATION } from "../src/calibration/types";
import { listAllSignals as listLiveSignals } from "../src/calibration/db";
import { resolvedTp1Samples } from "../src/calibration/recalibrate";
import { printStandardCalibrationTables } from "../src/calibration/report";
import { loadHistoricalFile, windowStartIndex } from "../src/backtest/loadData";
import {
  closeBacktestDb,
  getBacktestDbPath,
  listBacktestSignals,
  openBacktestDb,
} from "../src/backtest/store";
import {
  longestLosingStreak,
  maxDrawdownR,
  runWalkForward,
} from "../src/backtest/engine";

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

function parseArgs(argv: string[]) {
  const file = argValue(argv, "--file");
  if (!file) {
    console.error(`
Usage:
  npm run backtest -- --file=C:\\path\\to\\XAUUSD_M5.json [--days=365] [--spread=0.25] [--mode=both]

Options:
  --file=     ForexSB/Dukas M5 JSON (required). Confirmed schema: time/open/high/low/close arrays.
  --days=     Lookback from last bar (default 365). Warmup history kept before window.
  --spread=   Absolute price spread for Gold (default 0.25 = $0.25). BUY pays +spread on entry.
  --mode=     scalping | intraday | both (default both)
  --asset=    XAUUSD | XAGUSD | BTCUSD (default XAUUSD)
`);
    process.exit(1);
  }

  const days = Number(argValue(argv, "--days") ?? 365);
  const spread = Number(argValue(argv, "--spread") ?? 0.25);
  const modeArg = (argValue(argv, "--mode") ?? "both").toLowerCase();
  const asset = (argValue(argv, "--asset") ?? "XAUUSD") as AssetId;

  let modes: TradeMode[] = ["scalping", "intraday"];
  if (modeArg === "scalping") modes = ["scalping"];
  else if (modeArg === "intraday") modes = ["intraday"];

  return {
    file,
    days: Number.isFinite(days) && days > 0 ? days : 365,
    spread: Number.isFinite(spread) && spread >= 0 ? spread : 0.25,
    modes,
    asset,
  };
}

function tryLiveWinRate(): number | null {
  try {
    // Read-only peek at live DB for sanity banner — never writes / merges
    const resolved = resolvedTp1Samples(listLiveSignals());
    if (resolved.length < 5) return null;
    const w = resolved.filter((s) => s.outcomeTp1 === "WIN").length;
    return (w / resolved.length) * 100;
  } catch {
    return null;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`
SMC Backtest (walk-forward, production generateSignal)
──────────────────────────────────────────────────────
File    : ${opts.file}
Asset   : ${opts.asset}
Modes   : ${opts.modes.join(", ")}
Days    : ${opts.days}
Spread  : ${opts.spread} (BUY entry += spread, SELL entry -= spread)
Store   : ${getBacktestDbPath()}  ← SEPARATE from live data/signals.db
`);

  const loaded = loadHistoricalFile(opts.file);
  console.log(`
Data quality
────────────
${loaded.timezoneNote}
Bars    : ${loaded.quality.bars}
Range   : ${loaded.quality.firstIso} → ${loaded.quality.lastIso}
Period  : ${loaded.quality.periodMinutes}m base (HTF resampled in-code from this series only)
Dupes   : ${loaded.quality.duplicates}  non-monotonic: ${loaded.quality.nonMonotonic}
Suspicious gaps (>1 bar, weekends excluded): ${loaded.quality.suspiciousGaps}
`);
  if (loaded.quality.gapRanges.length) {
    console.log("Gap samples (first few):");
    for (const g of loaded.quality.gapRanges.slice(0, 8)) {
      console.log(`  ${g.from} → ${g.to} (missing ~${g.missingBars} bars)`);
    }
  }
  if (loaded.quality.impliedFileSpreadPrice != null) {
    console.log(
      `File metadata spread≈${loaded.quality.impliedFileSpreadPrice} (points×point). ` +
        `Using CLI --spread=${opts.spread} instead.`,
    );
  }
  if (opts.spread === 0) {
    console.log("⚠ spread=0 — results are OPTIMISTIC (no transaction cost).");
  }

  const m5 = loaded.candles;
  const winStart = windowStartIndex(m5, opts.days);
  console.log(
    `\nWalk window starts at index ${winStart}/${m5.length} (${new Date(m5[winStart]?.time ?? 0).toISOString()})`,
  );
  console.log("Running walk-forward (no look-ahead HTF)…\n");

  const dbPath = getBacktestDbPath();
  closeBacktestDb();
  if (existsSync(dbPath)) {
    try {
      unlinkSync(dbPath);
      if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
      if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
    } catch {
      /* open with reset */
    }
  }
  const db = openBacktestDb(true);

  const t0 = Date.now();
  const stats = runWalkForward(db, m5, {
    assetId: opts.asset,
    modes: opts.modes,
    spread: opts.spread,
    windowStartIdx: winStart,
    onProgress: (done, total) => {
      if (done === 0 || done === total || done % 5000 === 0) {
        const pct = ((done / total) * 100).toFixed(1);
        process.stdout.write(`\r  progress ${done}/${total} (${pct}%)   `);
      }
    },
  });
  process.stdout.write("\n");
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s — signals fired: ${stats.signalsFired}`);

  const signals = listBacktestSignals(db);
  const resolved = resolvedTp1Samples(signals);
  const wins = resolved.filter((s) => s.outcomeTp1 === "WIN").length;
  const losses = resolved.filter((s) => s.outcomeTp1 === "LOSS").length;
  const overall = resolved.length ? (wins / resolved.length) * 100 : null;
  const avgRf = (() => {
    const closed = signals.filter((s) => s.fullPlanClosed && s.realizedRFull != null);
    if (!closed.length) return null;
    return closed.reduce((a, s) => a + (s.realizedRFull as number), 0) / closed.length;
  })();
  const maxDd = maxDrawdownR(stats.equityR);
  const loseStreak = longestLosingStreak(signals);

  console.log(`
════════════════════════════════════════════════════════
SANITY CHECKS (read these before trusting the numbers)
════════════════════════════════════════════════════════
Spread assumption     : ${opts.spread} price units on entry
Overall TP1 win rate  : ${overall == null ? "—" : overall.toFixed(1) + "%"}  (n=${resolved.length}, W=${wins} L=${losses})
Avg realizedR_full    : ${avgRf == null ? "—" : avgRf.toFixed(3)}
Max drawdown (R)      : ${maxDd}
Longest losing streak : ${loseStreak}
`);

  const liveWr = tryLiveWinRate();
  if (liveWr != null) {
    console.log(`Live calibration TP1 win% (all-time sample): ${liveWr.toFixed(1)}%`);
  }
  if (overall != null && overall > 75) {
    console.log(`
⚠⚠⚠ IMPLAUSIBLY HIGH BACKTEST WIN RATE (>75%)
    Live measurement so far${liveWr != null ? ` is ~${liveWr.toFixed(1)}%` : " is typically far lower"}.
    This usually means residual look-ahead bias, missing spread/slippage, or data issues —
    NOT proof that the live formula is a 75%+ system. Do not treat this as validation.
`);
  }

  console.log("Signals per month:");
  const months = [...stats.byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  // Fill months in window
  if (months.length) {
    for (const [m, n] of months) {
      const flag =
        n === 0
          ? " ⚠ ZERO (possible data gap)"
          : n > 200
            ? " ⚠ unusually high vs live refresh rate — check walk loop"
            : "";
      console.log(`  ${m}: ${n}${flag}`);
    }
  }
  // Flag missing months inside span
  if (months.length >= 2) {
    const [y0, m0] = months[0][0].split("-").map(Number);
    const [y1, m1] = months[months.length - 1][0].split("-").map(Number);
    const keys = new Set(months.map((x) => x[0]));
    let y = y0;
    let m = m0;
    while (y < y1 || (y === y1 && m <= m1)) {
      const key = `${y}-${String(m).padStart(2, "0")}`;
      if (!keys.has(key)) {
        console.log(`  ${key}: 0 ⚠ ZERO (possible data gap)`);
      }
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }

  console.log(`
Backtest calibration tables (same report path as npm run calibrate)
Store: ${getBacktestDbPath()}
`);
  printStandardCalibrationTables(signals);

  console.log(`Methodology:
  • Production generateSignal() only — no parallel EMA/SMC copy
  • Walk-forward on closed ${loaded.quality.periodMinutes}m bars; HTF (15m/1H/4H/D) resampled
    from the same prefix; incomplete HTF candles discarded (no look-ahead)
  • Gap resolution = advanceSignalOnBar / resolveGapAmongLevels (ties → SL)
  • Entry fill simulated (price must touch entry zone; too-late / SL-before-entry → INVALIDATED)
  • One open plan per mode (matches live freeze)
  • Results NEVER written to data/signals.db
  • Live display recal still gated (≥${MIN_DAYS_BEFORE_DISPLAY_RECAL}d / n≥${MIN_SAMPLES_FOR_CALIBRATION} live samples)
`);

  closeBacktestDb();
}

main();
