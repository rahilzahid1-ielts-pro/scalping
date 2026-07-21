/**
 * Measurement-only: every live module through the SAME session-lock walk-forward
 * as the trusted 292/69.2%/59.9%/+0.341R baseline (daemon/backtest.ts).
 *
 *   npx tsx scripts/sessionLockAllModules.ts
 *   npx tsx scripts/sessionLockAllModules.ts --file=C:\path\XAUUSD_M5.json
 *
 * Does NOT change strategy logic. Module engines supply candidates; lock/zone/
 * resolve rules stay canAutoLockPlan → createFrozenPlan → zone-touch → SL-first.
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
  type SessionLockCandidateFn,
} from "../src/backtest/engine";
import type { AssetId, LiveSignal, TradeLevels, TradeMode } from "../src/types";
import { generateSignal } from "../src/strategies/signalEngine";
import { generateQuickScalpSignal } from "../src/strategies/quickScalpEngine";
import { generateProSignal } from "../src/strategies/proEngine";
import { generatePulseSignal } from "../src/strategies/pulseEngine";
import { generateFractalLiveSignal } from "../src/strategies/fractalLive";
import { generateCipherBLiveSignal } from "../src/strategies/cipherBLive";

const DEFAULT_FILE = "C:/scalping/data/XAUUSD_M5.json";
const OUT = "data/_session_lock_all_modules.json";
const SPREAD = 0.25;
const DAYS = 365;
const ASSET: AssetId = "XAUUSD";
const LOW_N = 50;

type ModuleSpec = {
  id: string;
  label: string;
  mode: TradeMode;
  /** undefined = main generateSignal path (trusted baseline) */
  candidate?: SessionLockCandidateFn;
};

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

function levelsFromModule(
  entry: number,
  sl: number,
  tp1: number,
  tp2: number,
): TradeLevels {
  const risk = Math.abs(entry - sl);
  return {
    entry,
    stopLoss: sl,
    takeProfit1: tp1,
    takeProfit2: tp2,
    takeProfit3: tp2,
    riskReward: risk > 0 ? Math.abs(tp1 - entry) / risk : 0,
    invalidation: sl,
  };
}

/** Overlay module direction/levels onto an SMC LiveSignal shell for session-lock. */
function overlayModule(
  shell: LiveSignal,
  mod: {
    direction: "BUY" | "SELL";
    entry: number;
    sl: number;
    tp1: number;
    tp2: number;
    confidence: number;
  },
): LiveSignal {
  return {
    ...shell,
    side: mod.direction,
    confidence: mod.confidence,
    levels: levelsFromModule(mod.entry, mod.sl, mod.tp1, mod.tp2),
    rangePrediction: {
      ...shell.rangePrediction,
      winProbability: Math.max(
        shell.rangePrediction.winProbability,
        mod.confidence,
      ),
    },
  };
}

function moduleCandidate(
  emit: (
    frames: Parameters<SessionLockCandidateFn>[0],
    mode: TradeMode,
    assetId: AssetId,
  ) => {
    direction: "BUY" | "SELL";
    entry: number;
    sl: number;
    tp1: number;
    tp2: number;
    confidence: number;
  } | null,
): SessionLockCandidateFn {
  return (frames, mode, assetId) => {
    const shell = generateSignal(assetId, mode, frames);
    const mod = emit(frames, mode, assetId);
    if (!mod) return null;
    return overlayModule(shell, mod);
  };
}

const MODULES: ModuleSpec[] = [
  { id: "main_scalp", label: "Main Scalp", mode: "scalping" },
  { id: "main_intraday", label: "Main Intraday", mode: "intraday" },
  {
    id: "quick_scalp",
    label: "Quick Scalp (BLITZ)",
    mode: "scalping",
    candidate: moduleCandidate((frames, mode, assetId) => {
      const sig = generateQuickScalpSignal(frames, assetId, mode);
      if (!sig) return null;
      return {
        direction: sig.direction,
        entry: sig.entry,
        sl: sig.sl,
        tp1: sig.tp1,
        tp2: sig.tp2,
        confidence: sig.confidence,
      };
    }),
  },
  {
    id: "pro",
    label: "Pro",
    mode: "intraday",
    candidate: moduleCandidate((frames, mode, assetId) => {
      const sig = generateProSignal(assetId, frames, mode);
      if (!sig) return null;
      return {
        direction: sig.direction,
        entry: sig.entry,
        sl: sig.sl,
        tp1: sig.tp1,
        tp2: sig.tp2,
        confidence: sig.confidence,
      };
    }),
  },
  {
    id: "fractal",
    label: "TTrades Fractal",
    mode: "scalping",
    candidate: moduleCandidate((frames, mode, assetId) => {
      const sig = generateFractalLiveSignal({ ...frames, assetId, mode });
      if (!sig) return null;
      return {
        direction: sig.direction,
        entry: sig.entry,
        sl: sig.sl,
        tp1: sig.tp1,
        tp2: sig.tp2,
        confidence: sig.confidence,
      };
    }),
  },
  {
    id: "qs_pro",
    label: "QS Pro",
    mode: "scalping",
    candidate: moduleCandidate((frames, mode, assetId) => {
      const sig = generatePulseSignal(frames, assetId, mode);
      if (!sig) return null;
      return {
        direction: sig.direction,
        entry: sig.entry,
        sl: sig.sl,
        tp1: sig.tp1,
        tp2: sig.tp2,
        confidence: sig.confidence,
      };
    }),
  },
  {
    id: "cipher_b",
    label: "Cipher B",
    mode: "scalping",
    candidate: moduleCandidate((frames, mode, assetId) => {
      const sig = generateCipherBLiveSignal({ ...frames, assetId, mode });
      if (!sig) return null;
      return {
        direction: sig.direction,
        entry: sig.entry,
        sl: sig.sl,
        tp1: sig.tp1,
        tp2: sig.tp2,
        confidence: sig.confidence,
      };
    }),
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

function runOne(
  spec: ModuleSpec,
  candles: ReturnType<typeof loadHistoricalFile>["candles"],
  windowStartIdx: number,
) {
  const db = resetDb();
  const t0 = Date.now();
  const stats = runWalkForward(db, candles, {
    assetId: ASSET,
    modes: [spec.mode],
    spread: SPREAD,
    windowStartIdx,
    trendConfirmBars: 4,
    signalCandidate: spec.candidate,
    onProgress: (done, total) => {
      if (done === 0 || done === total || done % 10000 === 0) {
        process.stdout.write(
          `\r  ${spec.label} ${done}/${total} (${((done / total) * 100).toFixed(0)}%)   `,
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
  const tp1Hits = resolved.filter((s) => s.outcomeTp1 === "WIN").length;
  const slHits = resolved.filter((s) => s.outcomeTp1 === "LOSS").length;
  const tp2Hits = touched.filter((s) => s.tp2Hit).length;
  const avgRFull = (() => {
    const closed = touched.filter(
      (s) => s.fullPlanClosed && s.realizedRFull != null,
    );
    if (!closed.length) return null;
    return (
      closed.reduce((a, s) => a + (s.realizedRFull as number), 0) / closed.length
    );
  })();
  const avgRTp1 = (() => {
    const withR = resolved.filter((s) => s.realizedR != null);
    if (!withR.length) return null;
    return withR.reduce((a, s) => a + (s.realizedR as number), 0) / withR.length;
  })();

  const zoneTouchPct = zoneTouchRate(stats);
  const winRate = conditionalTp1WinRate(stats);
  const lowConfidence = resolved.length < LOW_N;

  const row = {
    id: spec.id,
    label: spec.label,
    mode: spec.mode,
    locked: stats.signalsFired,
    zoneTouched: stats.zoneTouched,
    zoneTouchPct,
    executedResolved: resolved.length,
    tp1Hits,
    tp2Hits,
    slHits,
    winRate,
    avgR: avgRFull ?? avgRTp1,
    avgR_tp1: avgRTp1,
    avgR_full: avgRFull,
    maxDrawdownR: maxDrawdownR(stats.equityR),
    longestLosingStreak: longestLosingStreak(signals),
    lowConfidence,
    elapsedSec: (Date.now() - t0) / 1000,
  };

  const zt = zoneTouchPct == null ? "n/a" : `${zoneTouchPct.toFixed(1)}%`;
  const wr = winRate == null ? "n/a" : `${winRate.toFixed(1)}%`;
  const ar =
    row.avgR == null ? "n/a" : `${row.avgR >= 0 ? "+" : ""}${row.avgR.toFixed(3)}R`;
  console.log(
    `${spec.label.padEnd(22)} locked=${String(row.locked).padStart(4)}  ` +
      `touch=${zt.padStart(6)}  n=${String(row.executedResolved).padStart(4)}  ` +
      `WR=${wr.padStart(6)}  avgR=${ar}` +
      (lowConfidence ? "  ⚠ LOW CONFIDENCE" : ""),
  );
  return row;
}

function main() {
  const file = argValue(process.argv.slice(2), "--file") ?? DEFAULT_FILE;
  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  console.log(`Loading ${file}…`);
  const loaded = loadHistoricalFile(file);
  const candles = loaded.candles;
  const winStart = windowStartIndex(candles, DAYS);

  console.log(`
Trusted session-lock methodology (identical for every module)
────────────────────────────────────────────────────────────
File       : ${file}
Range      : ${loaded.quality.firstIso} → ${loaded.quality.lastIso}
Bars       : ${loaded.quality.bars}
Window     : last ${DAYS}d from end (start idx ${winStart})
Spread     : ${SPREAD}
Resolution : canAutoLockPlan → createFrozenPlan → zone-touch → SL-first same-bar
Gates      : current post-hotfix engines (same-candle fractal, strict Pro Daily)
`);

  const results = [];
  for (const spec of MODULES) {
    console.log(`\n======== ${spec.label} (${spec.mode}) ========`);
    results.push(runOne(spec, candles, winStart));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    method:
      "runWalkForward session-lock (same as trusted 292 baseline). Module engines supply candidates only; zone-touch required before TP1/SL count.",
    file,
    days: DAYS,
    spread: SPREAD,
    data: loaded.quality,
    windowStartIdx: winStart,
    windowStartIso: new Date(candles[winStart]?.time ?? 0).toISOString(),
    lowConfidenceThreshold: LOW_N,
    results,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${OUT}`);

  console.log("\n======== COMBINED TABLE ========");
  console.log(
    "Module                 | Locked | Touch% | Exec n | TP1 | TP2 | SL | Win%   | Avg R   | MaxDD  | LoseStreak | Flag",
  );
  console.log(
    "-----------------------|--------|--------|--------|-----|-----|----|--------|---------|--------|------------|------",
  );
  for (const r of results) {
    const zt = r.zoneTouchPct == null ? "n/a" : `${r.zoneTouchPct.toFixed(1)}%`;
    const wr = r.winRate == null ? "n/a" : `${r.winRate.toFixed(1)}%`;
    const ar =
      r.avgR == null ? "n/a" : `${r.avgR >= 0 ? "+" : ""}${r.avgR.toFixed(3)}`;
    const flag = r.lowConfidence ? "LOW CONFIDENCE — small sample" : "";
    console.log(
      `${r.label.padEnd(22)} | ${String(r.locked).padStart(6)} | ${zt.padStart(6)} | ${String(r.executedResolved).padStart(6)} | ${String(r.tp1Hits).padStart(3)} | ${String(r.tp2Hits).padStart(3)} | ${String(r.slHits).padStart(2)} | ${wr.padStart(6)} | ${ar.padStart(7)} | ${String(r.maxDrawdownR).padStart(6)} | ${String(r.longestLosingStreak).padStart(10)} | ${flag}`,
    );
  }
}

main();
