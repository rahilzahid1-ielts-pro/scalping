/**
 * Backtest prefer/lean modules on XAU_5m CSV → labeled TP/SL rows → train learn model.
 *
 *   npm run learn:bt -- --file=data/XAU_5m_data.csv --days=365 --spread=0.25
 *
 * HTF is resampled from M5 (prod parity) — separate 15m/1h CSV files are not mixed in.
 */
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  loadHistoricalFile,
  filterLastDays,
  windowStartIndex,
} from "../src/backtest/loadData";
import { framesAtIndex, precomputeHtfs } from "../src/backtest/frames";
import { runWalkForward } from "../src/backtest/engine";
import {
  closeBacktestDb,
  getBacktestDbPath,
  listBacktestSignals,
  openBacktestDb,
} from "../src/backtest/store";
import { runCompareStrategyBacktest } from "../src/strategyCompare/backtest";
import {
  getBacktestStrategyDb,
  listStrategyRows,
} from "../src/strategyCompare/store";
import { runPulseBacktest } from "../src/pulse/backtest";
import { getBacktestPulseDb, listPulseRows } from "../src/pulse/store";
import { runQuickScalpBacktest } from "../src/quickScalp/backtest";
import {
  getBacktestQuickScalpDb,
  listQuickScalpRows,
} from "../src/quickScalp/store";
import { runProBacktest } from "../src/pro/backtest";
import { getBacktestProDb, listProRows } from "../src/pro/store";
import {
  generateIntra30Signal,
  isWeakCandle,
  INTRA30_SL_DISTANCE,
  INTRA30_TP_DISTANCE,
  INTRA30_TP2_DISTANCE,
  INTRA30_POST_RESOLVE_COOLDOWN_BARS,
  INTRA30_OPPOSITE_BLOCK_BARS,
  type Intra30Direction,
} from "../src/strategies/intra30Engine";
import {
  getBacktestIntra30Db,
  insertIntra30Row,
  listIntra30Rows,
  signalToRow,
  updateIntra30Outcome,
  intra30RealizedR,
  type Intra30Outcome,
} from "../src/intra30/store";
import type { Candle } from "../src/types";
import type { LearnModule, LearnRow } from "../src/learn/types";
import { trainLogisticSlModel } from "../src/learn/train";
import {
  LEARN_DIR,
  MODEL_PATH,
  REPORT_PATH,
  saveModel,
  saveReport,
} from "../src/learn/modelStore";
import { loadLearnRowsFromDir } from "../src/learn/csvImport";

const DEFAULT_FILE = "data/XAU_5m_data.csv";

/** All desks except Scalp (noise / fat-SL spam). */
const TRAIN_MODULES = [
  "intraday",
  "pro",
  "cipher_b",
  "fractal",
  "qs_pro",
  "quick_scalp",
  "intra30",
] as const;

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

function applySpread(side: "BUY" | "SELL", open: number, spread: number): number {
  if (spread <= 0) return open;
  return side === "BUY" ? open + spread : open - spread;
}

function pushResolved(
  out: LearnRow[],
  partial: {
    id: string;
    module: LearnModule;
    moduleLabel: string;
    side: "BUY" | "SELL";
    entry: number;
    sl: number;
    tp1: number;
    executedAt: number;
    resolvedAt: number | null;
    outcome: "TP1_HIT" | "TP2_HIT" | "SL_HIT";
    realizedR: number | null;
  },
) {
  const slMoney = Math.abs(partial.entry - partial.sl);
  const tp1Money = Math.abs(partial.tp1 - partial.entry);
  out.push({
    ...partial,
    slMoney,
    tp1Money,
    pnlMoney:
      partial.realizedR != null
        ? Math.round(slMoney * partial.realizedR * 100) / 100
        : null,
    source: "backtest-m5",
  });
}

function collectCompare(strategy: "cipher_b_clone" | "fractal"): LearnRow[] {
  const module: LearnModule =
    strategy === "cipher_b_clone" ? "cipher_b" : "fractal";
  const label = strategy === "cipher_b_clone" ? "Cipher B" : "Fractal";
  const db = getBacktestStrategyDb(false);
  const out: LearnRow[] = [];
  for (const r of listStrategyRows(db, strategy)) {
    if (r.outcome !== "TP1_HIT" && r.outcome !== "SL_HIT") continue;
    pushResolved(out, {
      id: r.id,
      module,
      moduleLabel: label,
      side: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      executedAt: r.createdAt,
      resolvedAt: r.resolvedAt,
      outcome: r.outcome,
      realizedR: r.realizedR,
    });
  }
  return out;
}

function collectPulse(): LearnRow[] {
  const db = getBacktestPulseDb(false);
  const out: LearnRow[] = [];
  for (const r of listPulseRows(db)) {
    if (r.outcome !== "TP1_HIT" && r.outcome !== "TP2_HIT" && r.outcome !== "SL_HIT") {
      continue;
    }
    pushResolved(out, {
      id: r.id,
      module: "qs_pro",
      moduleLabel: "QS Pro",
      side: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      executedAt: r.executedAt ?? r.timestamp,
      resolvedAt: r.resolvedAt,
      outcome: r.outcome as "TP1_HIT" | "TP2_HIT" | "SL_HIT",
      realizedR: r.realizedR,
    });
  }
  return out;
}

function collectQuickScalp(): LearnRow[] {
  const db = getBacktestQuickScalpDb(false);
  const out: LearnRow[] = [];
  for (const r of listQuickScalpRows(db)) {
    if (r.outcome !== "TP1_HIT" && r.outcome !== "SL_HIT") continue;
    pushResolved(out, {
      id: r.id,
      module: "quick_scalp",
      moduleLabel: "Quick Scalp",
      side: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      executedAt: r.executedAt ?? r.timestamp,
      resolvedAt: r.resolvedAt,
      outcome: r.outcome,
      realizedR: r.realizedR,
    });
  }
  return out;
}

function collectPro(): LearnRow[] {
  const db = getBacktestProDb(false);
  const out: LearnRow[] = [];
  for (const r of listProRows(db)) {
    if (r.outcome !== "TP1_HIT" && r.outcome !== "SL_HIT") continue;
    pushResolved(out, {
      id: r.id,
      module: "pro",
      moduleLabel: "Pro",
      side: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      executedAt: r.executedAt ?? r.timestamp,
      resolvedAt: r.resolvedAt,
      outcome: r.outcome,
      realizedR: r.realizedR,
    });
  }
  return out;
}

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

/** Intraday session-lock path only (Scalp mode never run). */
function collectIntraday(
  candles: Candle[],
  days: number,
  spread: number,
): LearnRow[] {
  const winStart = windowStartIndex(candles, days);
  const db = resetMainBtDb();
  runWalkForward(db, candles, {
    assetId: "XAUUSD",
    modes: ["intraday"],
    spread,
    windowStartIdx: winStart,
  });
  closeBacktestDb();

  const out: LearnRow[] = [];
  for (const s of listBacktestSignals(openBacktestDb(false))) {
    if (s.mode !== "intraday") continue;
    if (s.zoneTouchedAt == null) continue;
    if (s.outcomeTp1 !== "WIN" && s.outcomeTp1 !== "LOSS") continue;
    pushResolved(out, {
      id: s.id,
      module: "intraday",
      moduleLabel: "Intraday",
      side: s.side,
      entry: s.entry,
      sl: s.sl,
      tp1: s.tp1,
      executedAt: s.zoneTouchedAt,
      resolvedAt: s.resolvedAt,
      outcome: s.outcomeTp1 === "WIN" ? "TP1_HIT" : "SL_HIT",
      realizedR: s.realizedR,
    });
  }
  closeBacktestDb();
  return out;
}

function runIntra30Collect(
  candles: Candle[],
  days: number,
  spread: number,
): LearnRow[] {
  const winStart = windowStartIndex(candles, days);
  const htfs = precomputeHtfs(candles);
  const db = getBacktestIntra30Db(true);
  const usedStrong = new Set<number>();
  type OpenT = {
    direction: Intra30Direction;
    entry: number;
    sl: number;
    tp1: number;
    tp2: number;
    entryIdx: number;
    tp1Reached: boolean;
    rowId: string;
  };
  const opens: OpenT[] = [];
  let lastResolveBar = -10_000;
  let lastResolveSide: Intra30Direction | null = null;

  function priceHit(
    side: "BUY" | "SELL",
    bar: Candle,
    sl: number,
    tp1: number,
    tp2: number,
  ): "SL_HIT" | "TP2_HIT" | "TP1_TOUCH" | null {
    const hitSl = side === "BUY" ? bar.low <= sl : bar.high >= sl;
    const hitTp1 = side === "BUY" ? bar.high >= tp1 : bar.low <= tp1;
    const hitTp2 = side === "BUY" ? bar.high >= tp2 : bar.low <= tp2;
    if (hitSl && (hitTp1 || hitTp2)) return "SL_HIT";
    if (hitSl) return "SL_HIT";
    if (hitTp2) return "TP2_HIT";
    if (hitTp1) return "TP1_TOUCH";
    return null;
  }

  for (let i = Math.max(winStart, 220); i < candles.length - 1; i++) {
    const bar = candles[i];
    const prior = i > 0 ? candles[i - 1] : null;
    const still: OpenT[] = [];
    for (const t of opens) {
      let outcome: Intra30Outcome | null = null;
      const px = priceHit(t.direction, bar, t.sl, t.tp1, t.tp2);
      if (px === "SL_HIT") outcome = "SL_HIT";
      else if (px === "TP2_HIT") outcome = "TP2_HIT";
      else if (px === "TP1_TOUCH") t.tp1Reached = true;
      if (!outcome && t.tp1Reached && prior && isWeakCandle(prior)) {
        outcome = "TP1_HIT";
      }
      if (!outcome && i - t.entryIdx >= 96) {
        outcome = t.tp1Reached ? "TP1_HIT" : "SL_HIT";
      }
      if (outcome) {
        updateIntra30Outcome(
          db,
          t.rowId,
          outcome,
          intra30RealizedR(outcome),
          bar.time,
        );
        lastResolveBar = i;
        lastResolveSide = t.direction;
      } else still.push(t);
    }
    opens.length = 0;
    opens.push(...still);
    if (opens.length >= 1) continue;

    const entryIdx = i + 1;
    const base = framesAtIndex(candles, i, "scalping", htfs);
    if (!base) continue;
    const tip = candles[entryIdx];
    const forming: Candle = {
      time: tip.time,
      open: tip.open,
      high: tip.open,
      low: tip.open,
      close: tip.open,
      volume: 0,
    };
    const frames = {
      primary: [...base.primary, forming],
      confirmation: base.confirmation,
      bias: base.bias,
      daily: base.daily,
    };
    const sig = generateIntra30Signal("XAUUSD", frames);
    if (!sig) continue;
    if (usedStrong.has(sig.strongBarTime)) continue;
    if (sig.strongBarTime !== candles[i].time) continue;
    const barsSince = i - lastResolveBar;
    if (barsSince < INTRA30_POST_RESOLVE_COOLDOWN_BARS) continue;
    if (
      lastResolveSide &&
      sig.direction !== lastResolveSide &&
      barsSince < INTRA30_OPPOSITE_BLOCK_BARS
    ) {
      continue;
    }
    usedStrong.add(sig.strongBarTime);
    const entry = applySpread(sig.direction, candles[entryIdx].open, spread);
    const sl =
      sig.direction === "BUY"
        ? entry - INTRA30_SL_DISTANCE
        : entry + INTRA30_SL_DISTANCE;
    const tp1 =
      sig.direction === "BUY"
        ? entry + INTRA30_TP_DISTANCE
        : entry - INTRA30_TP_DISTANCE;
    const tp2 =
      sig.direction === "BUY"
        ? entry + INTRA30_TP2_DISTANCE
        : entry - INTRA30_TP2_DISTANCE;
    const adjusted = {
      ...sig,
      entry,
      sl,
      tp1,
      tp2,
      time: candles[entryIdx].time,
    };
    const row = signalToRow(adjusted, "XAUUSD", "backtest");
    insertIntra30Row(db, row);
    db.prepare(
      `UPDATE intra30_signals SET executed_at = ?, outcome = 'OPEN' WHERE id = ?`,
    ).run(candles[entryIdx].time, row.id);
    opens.push({
      direction: sig.direction,
      entry,
      sl,
      tp1,
      tp2,
      entryIdx,
      tp1Reached: false,
      rowId: row.id,
    });
  }

  const out: LearnRow[] = [];
  for (const r of listIntra30Rows(db)) {
    if (
      r.outcome !== "TP1_HIT" &&
      r.outcome !== "TP2_HIT" &&
      r.outcome !== "SL_HIT"
    ) {
      continue;
    }
    pushResolved(out, {
      id: r.id,
      module: "intra30",
      moduleLabel: "Intra30",
      side: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      executedAt: r.executedAt ?? r.timestamp,
      resolvedAt: r.resolvedAt,
      outcome: r.outcome,
      realizedR: r.realizedR,
    });
  }
  return out;
}

/** One pass: all desks except Scalp on the given candle window. */
export function collectNoScalpLabels(
  candles: Candle[],
  days: number,
  spread: number,
  log: (...args: unknown[]) => void = console.log,
): LearnRow[] {
  const labeled: LearnRow[] = [];

  {
    const t = Date.now();
    log("  Backtest intraday…");
    const rows = collectIntraday(candles, days, spread);
    labeled.push(...rows);
    const w = rows.filter((r) => r.outcome !== "SL_HIT").length;
    const l = rows.filter((r) => r.outcome === "SL_HIT").length;
    log(`    → ${rows.length} (${w}W/${l}L) · ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }

  {
    const t = Date.now();
    log("  Backtest pro…");
    const stats = runProBacktest({ candles, days, spread, symbol: "XAUUSD" });
    const rows = collectPro();
    labeled.push(...rows);
    log(
      `    → ${rows.length} (${stats.wins}W/${stats.losses}L) · ${((Date.now() - t) / 1000).toFixed(1)}s`,
    );
  }

  for (const strategy of ["cipher_b_clone", "fractal"] as const) {
    const t = Date.now();
    log(`  Backtest ${strategy}…`);
    const stats = runCompareStrategyBacktest({
      candles,
      strategy,
      days,
      spread,
    });
    const rows = collectCompare(strategy);
    labeled.push(...rows);
    log(
      `    → ${rows.length} (${stats.wins}W/${stats.losses}L) · ${((Date.now() - t) / 1000).toFixed(1)}s`,
    );
  }

  {
    const t = Date.now();
    log("  Backtest qs_pro…");
    const stats = runPulseBacktest({ candles, days, spread });
    const rows = collectPulse();
    labeled.push(...rows);
    log(
      `    → ${rows.length} (${stats.wins}W/${stats.losses}L) · ${((Date.now() - t) / 1000).toFixed(1)}s`,
    );
  }

  {
    const t = Date.now();
    log("  Backtest quick_scalp…");
    const stats = runQuickScalpBacktest({ candles, days, spread });
    const rows = collectQuickScalp();
    labeled.push(...rows);
    log(
      `    → ${rows.length} (${stats.wins}W/${stats.losses}L) · ${((Date.now() - t) / 1000).toFixed(1)}s`,
    );
  }

  {
    const t = Date.now();
    log("  Backtest intra30…");
    const rows = runIntra30Collect(candles, days, spread);
    labeled.push(...rows);
    const w = rows.filter((r) => r.outcome !== "SL_HIT").length;
    const l = rows.filter((r) => r.outcome === "SL_HIT").length;
    log(`    → ${rows.length} (${w}W/${l}L) · ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }

  return labeled.filter((r) => r.module !== "scalp");
}

function main() {
  const argv = process.argv.slice(2);
  const file = argValue(argv, "--file") ?? DEFAULT_FILE;
  const days = Number(argValue(argv, "--days") ?? 365);
  const spread = Number(argValue(argv, "--spread") ?? 0.25);
  const mergeLiveCsv = argValue(argv, "--merge-csv"); // e.g. D:/download

  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  console.log(`Loading ${file}…`);
  const t0 = Date.now();
  const loaded = loadHistoricalFile(file);
  console.log(
    `Loaded ${loaded.quality.bars} bars (${loaded.quality.periodMinutes}m) in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  console.log(`Range: ${loaded.quality.firstIso} → ${loaded.quality.lastIso}`);
  if (loaded.quality.periodMinutes !== 5) {
    console.warn("⚠ Expected M5 base — HTF resample from this series.");
  }

  const candles = filterLastDays(loaded.candles, days);
  const winStart = windowStartIndex(candles, days);
  console.log(
    `Window last ${days}d · ${candles.length} bars · start idx ${winStart} · spread=${spread}`,
  );
  console.log(
    `Train modules (NO Scalp): ${TRAIN_MODULES.join(", ")}`,
  );
  console.log(
    "TF: scalping-family M5/M15/H1/D1 · Intraday/Pro M15/H1/H4/D1 (HTF from M5)\n",
  );

  const labeled = collectNoScalpLabels(candles, days, spread);

  if (mergeLiveCsv && existsSync(mergeLiveCsv)) {
    const live = loadLearnRowsFromDir(mergeLiveCsv).filter(
      (r) => r.module !== "scalp",
    );
    console.log(
      `Merging ${live.length} live CSV EXECUTED rows (Scalp excluded) from ${mergeLiveCsv}`,
    );
    labeled.push(...live);
  }

  // Hard exclude Scalp from training set
  const clean = labeled.filter((r) => r.module !== "scalp");
  clean.sort((a, b) => a.executedAt - b.executedAt);
  if (!existsSync(LEARN_DIR)) mkdirSync(LEARN_DIR, { recursive: true });
  const labelsPath = join(LEARN_DIR, "labeled_backtest.jsonl");
  writeFileSync(
    labelsPath,
    clean.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );

  console.log(`\nTotal labeled rows (no Scalp): ${clean.length}`);
  if (clean.length < 8) {
    console.error("Not enough labels to train.");
    process.exit(1);
  }

  const model = trainLogisticSlModel(clean);
  saveModel(model);

  const byMod: Record<string, { w: number; l: number }> = {};
  for (const r of clean) {
    byMod[r.module] ??= { w: 0, l: 0 };
    if (r.outcome === "SL_HIT") byMod[r.module].l += 1;
    else byMod[r.module].w += 1;
  }

  const report = {
    trainedAt: model.trainedAt,
    source: "backtest-m5-no-scalp",
    file,
    days,
    spread,
    exclude: ["scalp"],
    trainModules: [...TRAIN_MODULES],
    sampleN: model.sampleN,
    winN: model.winN,
    lossN: model.lossN,
    metrics: model.metrics,
    byModule: byMod,
    slCauses: model.slCauses,
    thresholds: model.thresholds,
    labelsPath,
    modelPath: MODEL_PATH,
    timeframes: {
      note: "HTF resampled from M5 in backtest (prod parity)",
      scalpingFamily: {
        primary: "M5",
        confirmation: "M15",
        bias: "H1",
        daily: "D1",
      },
      intradayPro: {
        primary: "M15",
        confirmation: "H1",
        bias: "H4",
        daily: "D1",
      },
    },
  };
  saveReport(report);

  console.log(`
======== LEARN ALL MODULES (NO SCALP) ========
Samples     : ${model.sampleN}  (${model.winN}W / ${model.lossN}L)
Holdout acc : ${(model.metrics.accuracy * 100).toFixed(1)}%
SL precision: ${(model.metrics.precisionSl * 100).toFixed(1)}%
SL recall   : ${(model.metrics.recallSl * 100).toFixed(1)}%
Baseline SL : ${(model.metrics.baselineSlRate * 100).toFixed(1)}%
Model       : ${MODEL_PATH}
Labels      : ${labelsPath}
Report      : ${REPORT_PATH}
`);

  console.log("By module:");
  for (const [m, s] of Object.entries(byMod).sort()) {
    const n = s.w + s.l;
    console.log(
      `  ${m.padEnd(12)} ${s.w}W/${s.l}L  WR ${n ? ((s.w / n) * 100).toFixed(0) : "—"}%`,
    );
  }
  console.log("\nTop SL causes:");
  for (const c of model.slCauses.slice(0, 6)) {
    console.log(`  [${c.pctOfLosses}%] ${c.label} n=${c.n} → ${c.fix}`);
  }
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("learnFromBacktest.ts");
if (isDirect) {
  main();
}
