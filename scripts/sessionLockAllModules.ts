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
import { setWaitingTooLateMode } from "../src/services/tradePlan";

const DEFAULT_FILE = "C:/scalping/data/XAUUSD_M5.json";
const OUT = "data/_session_lock_all_modules.json";
const SPREAD = 0.25;
const DAYS = 365;
const ASSET: AssetId = "XAUUSD";
const LOW_N = 50;
/** 30 pips on the live XAUUSD EAs = exactly $3.00 price distance. */
const FIXED_DISTANCE = 3;
const MFE_CHECKPOINTS = [1, 3, 5] as const;
/** Production B-state: reject-missed at lock kept; 0.5R wait-invalidation off. */
const REJECT_ALREADY_MISSED = true;

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
    rejectAlreadyMissed: REJECT_ALREADY_MISSED,
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
  const closeTimeToIndex = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) {
    const periodMs =
      i + 1 < candles.length
        ? candles[i + 1].time - candles[i].time
        : 5 * 60 * 1000;
    closeTimeToIndex.set(candles[i].time + periodMs, i);
  }
  const tpFirstBars: number[] = [];
  let slFirst = 0;
  let raceUnresolved = 0;
  let executedEvaluated = 0;
  const mfeByCheckpoint = new Map<number, number[]>(
    MFE_CHECKPOINTS.map((checkpoint) => [checkpoint, []]),
  );

  for (const signal of touched) {
    const touchedAt = signal.zoneTouchedAt;
    if (touchedAt == null) continue;
    const entryIndex = closeTimeToIndex.get(touchedAt);
    if (entryIndex == null) continue;
    executedEvaluated += 1;

    const target =
      signal.side === "BUY"
        ? signal.entry + FIXED_DISTANCE
        : signal.entry - FIXED_DISTANCE;
    const adverse =
      signal.side === "BUY"
        ? signal.entry - FIXED_DISTANCE
        : signal.entry + FIXED_DISTANCE;

    let raceResolved = false;
    for (let i = entryIndex; i < candles.length; i++) {
      const bar = candles[i];
      const hitAdverse =
        signal.side === "BUY" ? bar.low <= adverse : bar.high >= adverse;
      const hitTarget =
        signal.side === "BUY" ? bar.high >= target : bar.low <= target;

      // Same ambiguity policy as the trusted pipeline: adverse/SL wins ties.
      if (hitAdverse) {
        slFirst += 1;
        raceResolved = true;
        break;
      }
      if (hitTarget) {
        // Execution candle is bar 1, following candle is bar 2, etc.
        tpFirstBars.push(i - entryIndex + 1);
        raceResolved = true;
        break;
      }
    }
    if (!raceResolved) raceUnresolved += 1;

    for (const checkpoint of MFE_CHECKPOINTS) {
      const endIndex = entryIndex + checkpoint - 1;
      if (endIndex >= candles.length) continue;
      let maxFavorable = 0;
      for (let i = entryIndex; i <= endIndex; i++) {
        const favorable =
          signal.side === "BUY"
            ? candles[i].high - signal.entry
            : signal.entry - candles[i].low;
        maxFavorable = Math.max(maxFavorable, favorable);
      }
      mfeByCheckpoint.get(checkpoint)!.push(maxFavorable);
    }
  }
  const tpFirstPct =
    executedEvaluated > 0
      ? (tpFirstBars.length / executedEvaluated) * 100
      : null;
  const slFirstPct =
    executedEvaluated > 0 ? (slFirst / executedEvaluated) * 100 : null;
  const avgBarsToTp =
    tpFirstBars.length > 0
      ? tpFirstBars.reduce((sum, bars) => sum + bars, 0) / tpFirstBars.length
      : null;
  const average = (values: number[]): number | null =>
    values.length > 0
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  const avgFavorableBar1 = average(mfeByCheckpoint.get(1)!);
  const avgFavorableBar3 = average(mfeByCheckpoint.get(3)!);
  const avgFavorableBar5 = average(mfeByCheckpoint.get(5)!);
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
  const lowConfidence = executedEvaluated < LOW_N;

  const row = {
    id: spec.id,
    label: spec.label,
    mode: spec.mode,
    locked: stats.signalsFired,
    zoneTouched: stats.zoneTouched,
    zoneTouchPct,
    executedN: executedEvaluated,
    executedResolved: resolved.length,
    tp1Hits,
    tp2Hits,
    slHits,
    tpFirst: tpFirstBars.length,
    slFirst,
    raceUnresolved,
    tpFirstPct,
    slFirstPct,
    avgBarsToTp,
    avgFavorableBar1,
    avgFavorableBar3,
    avgFavorableBar5,
    mfeSamplesBar1: mfeByCheckpoint.get(1)!.length,
    mfeSamplesBar3: mfeByCheckpoint.get(3)!.length,
    mfeSamplesBar5: mfeByCheckpoint.get(5)!.length,
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
      `touch=${zt.padStart(6)}  n=${String(row.executedN).padStart(4)}  ` +
      `WR=${wr.padStart(6)}  avgR=${ar}  ` +
      `fixedTP=${tpFirstPct == null ? "n/a" : `${tpFirstPct.toFixed(1)}%`}` +
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

  // Match production B-state after 0.5R wait-invalidation revert.
  setWaitingTooLateMode("legacy_nested");

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
Lifecycle  : B-state (reject-missed ON, 0.5R wait-invalidation OFF / legacy nested)
Gates      : current engines (same-candle fractal, strict Pro Daily)
`);

  const results = [];
  for (const spec of MODULES) {
    console.log(`\n======== ${spec.label} (${spec.mode}) ========`);
    results.push(runOne(spec, candles, winStart));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    method:
      `runWalkForward session-lock (same as trusted 292 baseline). Module engines supply candidates only; zone-touch required. Test A uses exactly +$${FIXED_DISTANCE.toFixed(2)}/-$${FIXED_DISTANCE.toFixed(2)} from spread-adjusted entry, execution candle counted as bar 1, SL wins same-bar ties. Test B is cumulative maximum favorable excursion through bars ${MFE_CHECKPOINTS.join(", ")}.`,
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

  console.log(`\n======== TEST A: ±$${FIXED_DISTANCE.toFixed(2)} RACE ========`);
  console.log(
    "Module                 | Exec n | TP first | SL first | Avg bars to TP | Unresolved | Flag",
  );
  console.log(
    "-----------------------|--------|----------|----------|----------------|------------|------",
  );
  for (const r of results) {
    const tp = r.tpFirstPct == null ? "n/a" : `${r.tpFirstPct.toFixed(1)}%`;
    const sl = r.slFirstPct == null ? "n/a" : `${r.slFirstPct.toFixed(1)}%`;
    const bars = r.avgBarsToTp == null ? "n/a" : r.avgBarsToTp.toFixed(2);
    const flag = r.lowConfidence ? "LOW CONFIDENCE — small sample" : "";
    console.log(
      `${r.label.padEnd(22)} | ${String(r.executedN).padStart(6)} | ${tp.padStart(8)} | ${sl.padStart(8)} | ${bars.padStart(14)} | ${String(r.raceUnresolved).padStart(10)} | ${flag}`,
    );
  }

  console.log("\n======== TEST B: CUMULATIVE FAVORABLE EXCURSION ========");
  console.log(
    "Module                 | Exec n | Avg @ bar 1 | Avg @ bar 3 | Avg @ bar 5 | Flag",
  );
  console.log(
    "-----------------------|--------|-------------|-------------|-------------|------",
  );
  for (const r of results) {
    const b1 = r.avgFavorableBar1 == null ? "n/a" : r.avgFavorableBar1.toFixed(3);
    const b3 = r.avgFavorableBar3 == null ? "n/a" : r.avgFavorableBar3.toFixed(3);
    const b5 = r.avgFavorableBar5 == null ? "n/a" : r.avgFavorableBar5.toFixed(3);
    const flag = r.lowConfidence ? "LOW CONFIDENCE — small sample" : "";
    console.log(
      `${r.label.padEnd(22)} | ${String(r.executedN).padStart(6)} | ${b1.padStart(11)} | ${b3.padStart(11)} | ${b5.padStart(11)} | ${flag}`,
    );
  }
}

main();
