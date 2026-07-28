/**
 * Occupancy-aware QS Pro runner validation with vs without gateLearnedLock.
 *
 * Each arm runs runWalkForward itself. With ML enabled, gateLearnedLock blocks
 * before createFrozenPlan/insertBacktestSignal, so blocked candidates never
 * occupy the session-lock slot and the next bar can relock, matching live shape.
 *
 *   npx tsx scripts/compareLearnedGateQsRunner.ts
 */
import { createHash } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { loadHistoricalFile, windowStartIndex } from "../src/backtest/loadData";
import {
  closeBacktestDb,
  getBacktestDbPath,
  listBacktestSignals,
  openBacktestDb,
} from "../src/backtest/store";
import { runWalkForward, type SessionLockCandidateFn } from "../src/backtest/engine";
import type { AssetId, Candle, LiveSignal, TradeLevels } from "../src/types";
import { generateSignal } from "../src/strategies/signalEngine";
import { generatePulseSignal } from "../src/strategies/pulseEngine";
import { setWaitingTooLateMode } from "../src/services/tradePlan";
import {
  advanceSignalOnBar,
  type AdvanceExitPolicy,
  type AdvancingSignal,
} from "../src/calibration/resolveOutcomes";
import type { LoggedSignal } from "../src/calibration/types";
import { getLearnModel, resetLearnRuntimeCache } from "../src/learn/runtime";
import { rAtPrice } from "../src/exits/exitPolicy";

const ASSET: AssetId = "XAUUSD";
const SPREAD = 0.25;
const DAYS = 365;
const OUT = "data/_learned_gate_qs_runner_compare.json";
const WARMUP_MS = 120 * 24 * 60 * 60 * 1000;

function levelsFrom(entry: number, sl: number, tp1: number, tp2: number): TradeLevels {
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

function overlay(shell: LiveSignal, mod: { direction: "BUY" | "SELL"; entry: number; sl: number; tp1: number; tp2: number; confidence: number }): LiveSignal {
  return {
    ...shell,
    side: mod.direction,
    confidence: mod.confidence,
    levels: levelsFrom(mod.entry, mod.sl, mod.tp1, mod.tp2),
    rangePrediction: {
      ...shell.rangePrediction,
      winProbability: Math.max(shell.rangePrediction.winProbability, mod.confidence),
    },
  };
}

const QS_PRO: SessionLockCandidateFn = (frames, mode, assetId) => {
  const shell = generateSignal(assetId, mode, frames);
  const sig = generatePulseSignal(frames, assetId, mode);
  if (!sig) return null;
  return overlay(shell, {
    direction: sig.direction,
    entry: sig.entry,
    sl: sig.sl,
    tp1: sig.tp1,
    tp2: sig.tp2,
    confidence: sig.confidence,
  });
};

function resetDb() {
  closeBacktestDb();
  const p = getBacktestDbPath();
  for (const f of [p, `${p}-wal`, `${p}-shm`]) {
    if (existsSync(f)) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
  return openBacktestDb(true);
}

function sliceWindow(all: Candle[], startIso: string, endIso: string) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  const candles = all.filter((c) => c.time >= start - WARMUP_MS && c.time <= end);
  const windowStartIdx = candles.findIndex((c) => c.time >= start);
  if (windowStartIdx < 0) throw new Error(`No bars in window ${startIso}`);
  return { candles, windowStartIdx };
}

function tradeKey(s: LoggedSignal): string {
  return `${s.planKey}|${s.zoneTouchedAt}|${s.side}|${s.entry}|${s.sl}|${s.tp1}`;
}

function setHash(keys: string[]): string {
  return createHash("sha256").update(keys.slice().sort().join("\n")).digest("hex").slice(0, 12);
}

function buildCloseTimeIndex(candles: Candle[]): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) {
    const periodMs = i + 1 < candles.length ? candles[i + 1].time - candles[i].time : 5 * 60 * 1000;
    m.set(candles[i].time + periodMs, i);
  }
  return m;
}

function seedOpen(s: LoggedSignal): AdvancingSignal {
  return {
    ...s,
    outcome: "OPEN",
    outcomeTp1: null,
    resolvedAt: null,
    realizedR: null,
    realizedRFull: null,
    fullPlanClosed: false,
    tp2Hit: false,
    tp3Hit: false,
    slAfterTp1: false,
    tp1HitAt: null,
    tp2HitAt: null,
    tp3HitAt: null,
    slAfterTp1At: null,
    resolveNote: undefined,
    runnerPeak: undefined,
    runnerStop: undefined,
    runnerBankedR: undefined,
    runnerRemaining: undefined,
    runnerFarTarget: undefined,
  };
}

function markToMarket(sig: AdvancingSignal, close: number): number {
  const risk = Math.abs(sig.entry - sig.sl) || 1e-9;
  const banked = sig.runnerBankedR ?? 0;
  const rem = sig.runnerRemaining ?? (sig.outcomeTp1 === "WIN" ? 0 : 1);
  if (sig.fullPlanClosed && sig.realizedR != null) return sig.realizedR;
  if (sig.outcomeTp1 === "LOSS") return -1;
  if (sig.outcomeTp1 == null) return Math.round(rAtPrice(sig.side, sig.entry, risk, close) * 1000) / 1000;
  return Math.round((banked + rem * rAtPrice(sig.side, sig.entry, risk, close)) * 1000) / 1000;
}

function replayPolicy(executed: LoggedSignal[], candles: Candle[], policy: AdvanceExitPolicy): number[] {
  const idx = buildCloseTimeIndex(candles);
  const rs: number[] = [];
  for (const src of executed) {
    const i0 = idx.get(src.zoneTouchedAt!);
    if (i0 == null) continue;
    let sig = seedOpen(src);
    for (let i = i0; i < candles.length; i++) {
      const bar = candles[i];
      const periodMs = i + 1 < candles.length ? candles[i + 1].time - bar.time : 5 * 60 * 1000;
      const next = advanceSignalOnBar(
        sig,
        { price: bar.close, open: bar.open, high: bar.high, low: bar.low },
        bar.time + periodMs,
        { exitPolicy: policy },
      );
      if (next) sig = next as AdvancingSignal;
      if (sig.fullPlanClosed) break;
    }
    rs.push(sig.fullPlanClosed && sig.realizedR != null ? sig.realizedR : markToMarket(sig, candles[candles.length - 1].close));
  }
  return rs;
}

function maxDd(rs: number[]): number {
  let equity = 0;
  let peak = 0;
  let dd = 0;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    dd = Math.max(dd, peak - equity);
  }
  return Math.round(dd * 1000) / 1000;
}

function score(label: string, executed: LoggedSignal[], candles: Candle[], policy: AdvanceExitPolicy) {
  const rs = replayPolicy(executed, candles, policy);
  const totalR = rs.reduce((a, b) => a + b, 0);
  const wins = rs.filter((r) => r > 1e-6).length;
  const losses = rs.filter((r) => r < -1e-6).length;
  return {
    label,
    n: rs.length,
    wins,
    losses,
    winRate: rs.length ? (wins / rs.length) * 100 : null,
    avgR: rs.length ? totalR / rs.length : null,
    totalR,
    maxDd: maxDd(rs),
  };
}

function fmt(s: ReturnType<typeof score>): string {
  const wr = s.winRate == null ? "n/a" : `${s.winRate.toFixed(1)}%`;
  const avg = s.avgR == null ? "n/a" : `${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(3)}`;
  return `${s.label.padEnd(24)} n=${String(s.n).padStart(4)} WR=${wr.padStart(6)} avgR=${avg.padStart(7)} totalR=${s.totalR.toFixed(1).padStart(7)} maxDD=${s.maxDd.toFixed(2)}`;
}

function runArm(candles: Candle[], windowStartIdx: number, learned: boolean) {
  resetLearnRuntimeCache();
  const db = resetDb();
  const stats = runWalkForward(db, candles, {
    assetId: ASSET,
    modes: ["scalping"],
    spread: SPREAD,
    windowStartIdx,
    trendConfirmBars: 4,
    rejectAlreadyMissed: true,
    signalCandidate: QS_PRO,
    learnedGateModule: learned ? "qs_pro" : undefined,
  });
  const signals = listBacktestSignals(db);
  closeBacktestDb();
  const executed = signals
    .filter((s) => s.zoneTouchedAt != null && (s.outcomeTp1 === "WIN" || s.outcomeTp1 === "LOSS"))
    .sort((a, b) => (a.zoneTouchedAt ?? a.timestamp) - (b.zoneTouchedAt ?? b.timestamp));
  return {
    stats,
    executed,
    fixed: score(learned ? "with ML fixed_tp1" : "without ML fixed_tp1", executed, candles, "fixed_tp1"),
    runner: score(learned ? "with ML runner" : "without ML runner", executed, candles, "runner_trail_peak"),
    setHash: setHash(executed.map(tradeKey)),
  };
}

function runWindow(spec: { id: string; file: string; startIso?: string; endIso?: string }) {
  const loaded = loadHistoricalFile(spec.file);
  const sliced = spec.startIso && spec.endIso
    ? sliceWindow(loaded.candles, spec.startIso, spec.endIso)
    : { candles: loaded.candles, windowStartIdx: windowStartIndex(loaded.candles, DAYS) };
  const { candles, windowStartIdx } = sliced;

  const withoutMl = runArm(candles, windowStartIdx, false);
  const withMl = runArm(candles, windowStartIdx, true);

  console.log(`\n── ${spec.id} ──`);
  console.log(`without hash=${withoutMl.setHash} locked=${withoutMl.stats.signalsFired}`);
  console.log(`with ML hash=${withMl.setHash} locked=${withMl.stats.signalsFired} blocks=${withMl.stats.learnedGateBlocks ?? 0}`);
  console.log(fmt(withoutMl.fixed));
  console.log(fmt(withoutMl.runner));
  console.log(fmt(withMl.fixed));
  console.log(fmt(withMl.runner));

  return {
    id: spec.id,
    file: spec.file,
    startIso: spec.startIso ?? null,
    endIso: spec.endIso ?? null,
    windowStartIdx,
    withoutMl: {
      locked: withoutMl.stats.signalsFired,
      setHash: withoutMl.setHash,
      fixed: withoutMl.fixed,
      runner: withoutMl.runner,
    },
    withMl: {
      locked: withMl.stats.signalsFired,
      learnedGateBlocks: withMl.stats.learnedGateBlocks ?? 0,
      setHash: withMl.setHash,
      fixed: withMl.fixed,
      runner: withMl.runner,
    },
  };
}

function main() {
  setWaitingTooLateMode("legacy_nested");
  resetLearnRuntimeCache();
  const model = getLearnModel();
  console.log(`model=${model ? `${model.trainedAt} n=${model.sampleN}` : "none"}`);
  const results = [
    runWindow({ id: "W1 last-365d JSON", file: "C:/scalping/data/XAUUSD_M5.json" }),
    runWindow({
      id: "W2 2024-01-30 to 2025-01-30 CSV",
      file: "C:/scalping/data/XAU_5m_data.csv",
      startIso: "2024-01-30T23:55:00.000Z",
      endIso: "2025-01-30T23:55:00.000Z",
    }),
  ];
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        methodology:
          "Two true runWalkForward arms per window: without ML vs learnedGateModule=qs_pro. Gate blocks before createFrozenPlan so occupancy re-opens. With-ML arm also notes resolves into recent[] (noteLearnResolved) so stack/after-TP features are live during the walk.",
        noteLearnResolvedFix:
          "Live resolve bots + calibration resolver now call noteResolvedTradeForLearn. Backtest with learnedGateModule notes on TP1 resolve. recent[] is no longer always empty.",
        model: model ? { trainedAt: model.trainedAt, sampleN: model.sampleN, thresholds: model.thresholds } : null,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${OUT}`);
}

main();
