/**
 * Trusted-pipeline verification for:
 *   A) Trend runner vs fixed_tp1 exit (same session-lock executed set)
 *   B) QS Pro entry guards before vs after (bounce + fallback tighten)
 *   C) Day-regime same-side gates (pause / chase / retrace / side-stop) as a
 *      post-filter on the AFTER lock stream
 *
 * Methodology (matches scripts/sessionLockAllModules.ts / daemon/backtest.ts):
 *   file=data/XAUUSD_M5.json  days=365  spread=0.25
 *   production B-state rejectAlreadyMissed=true
 *   canAutoLockPlan → createFrozenPlan → zone-touch → SL-priority same-bar
 *
 * Honest note: the previously reported +34–40% R for the runner was NOT from
 * this pipeline — it used CSV M5 + a custom cooldown emitter + simulateExit.
 * This script is the trusted re-measure.
 *
 *   npx tsx scripts/verifyTrustedExitsAndGuards.ts
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
  maxDrawdownR,
  runWalkForward,
  zoneTouchRate,
  type SessionLockCandidateFn,
} from "../src/backtest/engine";
import type { AssetId, Candle, LiveSignal, TradeLevels, TradeMode } from "../src/types";
import { generateSignal } from "../src/strategies/signalEngine";
import { generatePulseSignal } from "../src/strategies/pulseEngine";
import { generateFractalSignal } from "../src/strategies/archived/fractalSignal";
import {
  dailyAgreesWithSide,
  hasFreshExtreme,
  isCounterBounce,
  isExtendedChase,
} from "../src/utils/entryFilters";
import { setWaitingTooLateMode } from "../src/services/tradePlan";
import {
  buildExitPlan,
  LIVE_EXIT_POLICY,
  simulateExit,
  type ExitPolicyId,
} from "../src/exits/exitPolicy";
import { karachiYmd } from "../src/history/apiHistory";
import type { LoggedSignal } from "../src/calibration/types";

const FILE = "C:/scalping/data/XAUUSD_M5.json";
const OUT = "data/_trusted_exits_guards.json";
const SPREAD = 0.25;
const DAYS = 365;
const ASSET: AssetId = "XAUUSD";
const REJECT_ALREADY_MISSED = true;

const POST_TP_MS = 90 * 60 * 1000;
const CHASE_USD = 8;
const CHASE_MS = 3 * 60 * 60 * 1000;
const RETRACE_USD = 3;
const SIDE_SL_SOFT = 2;
const SIDE_SL_HARD = 3;
const SIDE_COOLDOWN_MS = 2 * 60 * 60 * 1000;

function levelsFrom(
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

function overlay(
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
    levels: levelsFrom(mod.entry, mod.sl, mod.tp1, mod.tp2),
    rangePrediction: {
      ...shell.rangePrediction,
      winProbability: Math.max(
        shell.rangePrediction.winProbability,
        mod.confidence,
      ),
    },
  };
}

/** Pre-28-Jul QS Pro gate: conf≥75 fallback, no fresh-extreme, no bounce. */
function generatePulseSignalBeforeGuards(
  frames: Parameters<typeof generatePulseSignal>[0],
  assetId: AssetId = "XAUUSD",
  mode: TradeMode = "scalping",
) {
  const smc = generateSignal(assetId, mode, frames);
  if ((smc.side !== "BUY" && smc.side !== "SELL") || !smc.levels) return null;

  const fractal = generateFractalSignal({ candles: frames.primary });
  if (fractal) {
    if (smc.side !== fractal.direction) return null;
  } else if (smc.confidence < 75) {
    return null;
  }

  if (!dailyAgreesWithSide(smc.side, smc.dailyBias.bias)) return null;
  if (isExtendedChase(smc.side, frames.primary)) return null;
  // intentionally NO isCounterBounce, NO hasFreshExtreme

  const entry = smc.levels.entry;
  const sl = smc.levels.stopLoss;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  const tp1 =
    smc.side === "BUY" ? entry + risk * 0.85 : entry - risk * 0.85;
  const tp2 =
    smc.side === "BUY" ? entry + risk * 1.5 : entry - risk * 1.5;

  return {
    direction: smc.side as "BUY" | "SELL",
    entry,
    sl,
    tp1,
    tp2,
    confidence: smc.confidence,
    regime: smc.diagnostics.regime ?? "",
  };
}

function candidateFromEmit(
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
    return overlay(shell, mod);
  };
}

const AFTER_CANDIDATE = candidateFromEmit((frames, mode, assetId) => {
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
});

const BEFORE_CANDIDATE = candidateFromEmit((frames, mode, assetId) =>
  generatePulseSignalBeforeGuards(frames, assetId, mode),
);

function resetDb() {
  closeBacktestDb();
  const p = getBacktestDbPath();
  for (const f of [p, `${p}-wal`, `${p}-shm`]) {
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

function runSessionLock(
  label: string,
  candidate: SessionLockCandidateFn,
  candles: Candle[],
  windowStartIdx: number,
) {
  const db = resetDb();
  const t0 = Date.now();
  const stats = runWalkForward(db, candles, {
    assetId: ASSET,
    modes: ["scalping"],
    spread: SPREAD,
    windowStartIdx,
    trendConfirmBars: 4,
    rejectAlreadyMissed: REJECT_ALREADY_MISSED,
    signalCandidate: candidate,
    onProgress: (done, total) => {
      if (done === 0 || done === total || done % 15000 === 0) {
        process.stdout.write(
          `\r  ${label} ${done}/${total} (${((done / Math.max(1, total)) * 100).toFixed(0)}%)   `,
        );
      }
    },
  });
  process.stdout.write("\n");
  const signals = listBacktestSignals(db);
  return { label, stats, signals, elapsedSec: (Date.now() - t0) / 1000 };
}

function funnelRow(
  label: string,
  stats: ReturnType<typeof runWalkForward>,
  signals: LoggedSignal[],
) {
  const touched = signals.filter((s) => s.zoneTouchedAt != null);
  const resolved = touched.filter(
    (s) => s.outcomeTp1 === "WIN" || s.outcomeTp1 === "LOSS",
  );
  const wins = resolved.filter((s) => s.outcomeTp1 === "WIN").length;
  const losses = resolved.filter((s) => s.outcomeTp1 === "LOSS").length;
  const withR = resolved.filter((s) => s.realizedR != null);
  const avgRTp1 =
    withR.length > 0
      ? withR.reduce((a, s) => a + (s.realizedR as number), 0) / withR.length
      : null;
  return {
    label,
    locked: stats.signalsFired,
    zoneTouched: stats.zoneTouched,
    zoneTouchPct: zoneTouchRate(stats),
    executedN: resolved.length,
    wins,
    losses,
    slRate: resolved.length ? (losses / resolved.length) * 100 : null,
    winRate: conditionalTp1WinRate(stats),
    avgR_tp1: avgRTp1,
    maxDrawdownR: maxDrawdownR(stats.equityR),
  };
}

function fmtRow(r: ReturnType<typeof funnelRow>) {
  const zt = r.zoneTouchPct == null ? "n/a" : `${r.zoneTouchPct.toFixed(1)}%`;
  const wr = r.winRate == null ? "n/a" : `${r.winRate.toFixed(1)}%`;
  const sl = r.slRate == null ? "n/a" : `${r.slRate.toFixed(1)}%`;
  const ar =
    r.avgR_tp1 == null
      ? "n/a"
      : `${r.avgR_tp1 >= 0 ? "+" : ""}${r.avgR_tp1.toFixed(3)}R`;
  const dd =
    r.maxDrawdownR == null ? "n/a" : r.maxDrawdownR.toFixed(2);
  return (
    `${r.label.padEnd(28)} locked=${String(r.locked).padStart(4)}  ` +
    `touch=${zt.padStart(6)}  n=${String(r.executedN).padStart(4)}  ` +
    `WR=${wr.padStart(6)}  SL%=${sl.padStart(6)}  avgR=${ar.padStart(8)}  maxDD=${dd}`
  );
}

/** Map zoneTouchedAt (close-of-bar stamp) → M5 index. */
function buildCloseTimeIndex(candles: Candle[]): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < candles.length; i++) {
    const periodMs =
      i + 1 < candles.length
        ? candles[i + 1].time - candles[i].time
        : 5 * 60 * 1000;
    m.set(candles[i].time + periodMs, i);
  }
  return m;
}

function settleExitPolicy(
  signals: LoggedSignal[],
  candles: Candle[],
  policy: ExitPolicyId,
) {
  const idx = buildCloseTimeIndex(candles);
  const rs: number[] = [];
  let wins = 0;
  let losses = 0;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let skipped = 0;

  for (const s of signals) {
    if (s.zoneTouchedAt == null) continue;
    if (s.outcomeTp1 !== "WIN" && s.outcomeTp1 !== "LOSS") continue;
    const i = idx.get(s.zoneTouchedAt);
    if (i == null) {
      skipped += 1;
      continue;
    }
    const plan = buildExitPlan({
      policy,
      side: s.side,
      entry: s.entry,
      sl: s.sl,
      regime: s.regime,
    });
    // Start resolving on the bar AFTER entry fill (same as simulateExit convention).
    const res = simulateExit(plan, candles, i + 1);
    rs.push(res.realizedR);
    if (res.realizedR > 1e-6) wins += 1;
    else if (res.realizedR < -1e-6) losses += 1;
    equity += res.realizedR;
    if (equity > peak) peak = equity;
    if (equity - peak < maxDd) maxDd = equity - peak;
  }

  const n = rs.length;
  return {
    policy,
    n,
    skipped,
    wins,
    losses,
    winRate: n ? (wins / n) * 100 : null,
    slRate: n ? (losses / n) * 100 : null,
    avgR: n ? rs.reduce((a, b) => a + b, 0) / n : null,
    totalR: rs.reduce((a, b) => a + b, 0),
    maxDrawdownR: maxDd,
  };
}

/**
 * Apply lean-family day gates to an already-produced lock stream (QS Pro only).
 * This isolates pause/chase/retrace/side-stop without re-running the WF engine.
 */
function applyDayRegimeFilter(signals: LoggedSignal[]) {
  const kept: LoggedSignal[] = [];
  let leanLastTp: { at: number; side: "BUY" | "SELL"; entry: number } | null =
    null;
  const sideSl: Record<"BUY" | "SELL", { sl: number; lastSlAt: number | null }> =
    {
      BUY: { sl: 0, lastSlAt: null },
      SELL: { sl: 0, lastSlAt: null },
    };
  // Day-bucketed side counts — reset when Karachi date changes.
  let day = "";

  let blockedPause = 0;
  let blockedChase = 0;
  let blockedRetrace = 0;
  let blockedSide = 0;

  const sorted = [...signals].sort((a, b) => a.timestamp - b.timestamp);

  for (const s of sorted) {
    const d = karachiYmd(s.timestamp);
    if (d !== day) {
      day = d;
      sideSl.BUY = { sl: 0, lastSlAt: null };
      sideSl.SELL = { sl: 0, lastSlAt: null };
      // leanLastTp can span overnight within CHASE_MS — keep it
    }

    const side = s.side;
    const now = s.timestamp;
    let block: string | null = null;

    const sideState = sideSl[side];
    if (sideState.sl >= SIDE_SL_HARD) {
      block = "side-hard";
      blockedSide += 1;
    } else if (sideState.sl >= SIDE_SL_SOFT) {
      const since =
        sideState.lastSlAt == null ? Infinity : now - sideState.lastSlAt;
      if (since < SIDE_COOLDOWN_MS) {
        block = "side-soft";
        blockedSide += 1;
      }
    }

    if (
      !block &&
      leanLastTp &&
      leanLastTp.side === side &&
      now - leanLastTp.at < POST_TP_MS
    ) {
      block = "post-tp-pause";
      blockedPause += 1;
    }

    if (
      !block &&
      leanLastTp &&
      leanLastTp.side === side &&
      now - leanLastTp.at < CHASE_MS
    ) {
      const extension =
        side === "SELL"
          ? leanLastTp.entry - s.entry
          : s.entry - leanLastTp.entry;
      if (extension >= CHASE_USD) {
        block = "chase";
        blockedChase += 1;
      } else if (extension <= -RETRACE_USD) {
        block = "retrace";
        blockedRetrace += 1;
      }
    }

    if (block) continue;
    kept.push(s);

    // Update stamps from THIS signal's eventual outcome (look-ahead for day
    // state is unavoidable in a post-filter; live uses resolve-time stamps).
    if (s.outcomeTp1 === "WIN") {
      leanLastTp = {
        at: s.resolvedAt ?? s.timestamp,
        side,
        entry: s.entry,
      };
    } else if (s.outcomeTp1 === "LOSS") {
      sideSl[side].sl += 1;
      sideSl[side].lastSlAt = s.resolvedAt ?? s.timestamp;
    }
  }

  return {
    kept,
    blockedPause,
    blockedChase,
    blockedRetrace,
    blockedSide,
  };
}

function scoreKept(label: string, kept: LoggedSignal[]) {
  const touched = kept.filter((s) => s.zoneTouchedAt != null);
  const resolved = touched.filter(
    (s) => s.outcomeTp1 === "WIN" || s.outcomeTp1 === "LOSS",
  );
  const wins = resolved.filter((s) => s.outcomeTp1 === "WIN").length;
  const losses = resolved.filter((s) => s.outcomeTp1 === "LOSS").length;
  const withR = resolved.filter((s) => s.realizedR != null);
  const avgR =
    withR.length > 0
      ? withR.reduce((a, s) => a + (s.realizedR as number), 0) / withR.length
      : null;
  // equity curve in resolve order
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const s of [...resolved].sort(
    (a, b) => (a.resolvedAt ?? a.timestamp) - (b.resolvedAt ?? b.timestamp),
  )) {
    equity += s.realizedR ?? (s.outcomeTp1 === "WIN" ? 0.85 : -1);
    if (equity > peak) peak = equity;
    if (equity - peak < maxDd) maxDd = equity - peak;
  }
  return {
    label,
    locked: kept.length,
    zoneTouched: touched.length,
    zoneTouchPct: kept.length ? (touched.length / kept.length) * 100 : null,
    executedN: resolved.length,
    wins,
    losses,
    slRate: resolved.length ? (losses / resolved.length) * 100 : null,
    winRate: resolved.length ? (wins / resolved.length) * 100 : null,
    avgR_tp1: avgR,
    maxDrawdownR: maxDd,
  };
}

function main() {
  if (!existsSync(FILE)) {
    console.error(`Trusted file missing: ${FILE}`);
    process.exit(1);
  }

  setWaitingTooLateMode("legacy_nested");

  console.log(`Loading ${FILE}…`);
  const loaded = loadHistoricalFile(FILE);
  const candles = loaded.candles;
  const winStart = windowStartIndex(candles, DAYS);

  console.log(`
════════════════════════════════════════════════════════════════════════
TRUSTED PIPELINE — QS Pro exits + guards isolation
════════════════════════════════════════════════════════════════════════
File                  : ${FILE}
Range                 : ${loaded.quality.firstIso} → ${loaded.quality.lastIso}
Bars / window start   : ${loaded.quality.bars} / idx ${winStart}
Days / spread         : ${DAYS} / ${SPREAD}
B-state               : rejectAlreadyMissed=${REJECT_ALREADY_MISSED}
SL-priority same-bar  : YES (advanceSignalOnBar / resolveGapAmongLevels)
Session-lock          : canAutoLockPlan → zone-touch → TP1 resolve
`);

  console.log("── A. Session-lock QS Pro: BEFORE entry-guards vs AFTER ──\n");
  const before = runSessionLock("BEFORE guards", BEFORE_CANDIDATE, candles, winStart);
  const after = runSessionLock("AFTER guards", AFTER_CANDIDATE, candles, winStart);

  const beforeFunnel = funnelRow("QS Pro BEFORE (entry)", before.stats, before.signals);
  const afterFunnel = funnelRow("QS Pro AFTER (entry)", after.stats, after.signals);

  console.log("\nComparable funnel table (session-lock TP1 settlement):");
  console.log(fmtRow(beforeFunnel));
  console.log(fmtRow(afterFunnel));

  // How many AFTER locks would the bounce / fresh-extreme alone have blocked
  // if we inspect the difference in lock counts:
  console.log(
    `\nEntry-guard delta: locked ${beforeFunnel.locked} → ${afterFunnel.locked} ` +
      `(Δ ${afterFunnel.locked - beforeFunnel.locked}); ` +
      `executed ${beforeFunnel.executedN} → ${afterFunnel.executedN}; ` +
      `SL% ${beforeFunnel.slRate?.toFixed(1)} → ${afterFunnel.slRate?.toFixed(1)}; ` +
      `WR ${beforeFunnel.winRate?.toFixed(1)} → ${afterFunnel.winRate?.toFixed(1)}; ` +
      `avgR ${beforeFunnel.avgR_tp1?.toFixed(3)} → ${afterFunnel.avgR_tp1?.toFixed(3)}`,
  );

  console.log("\n── B. Day-regime gates on AFTER lock stream (post-filter) ──\n");
  const dayFiltered = applyDayRegimeFilter(after.signals);
  const afterDay = scoreKept(
    "QS Pro AFTER + day gates",
    dayFiltered.kept,
  );
  console.log(fmtRow(afterFunnel));
  console.log(fmtRow(afterDay));
  console.log(
    `  blocked: pause=${dayFiltered.blockedPause} chase=${dayFiltered.blockedChase} ` +
      `retrace=${dayFiltered.blockedRetrace} side=${dayFiltered.blockedSide}`,
  );

  console.log("\n── C. Exit policy on SAME AFTER executed set (trusted locks) ──\n");
  console.log(
    "NOTE: Previously published +34–40% used CSV + custom emitter, NOT this pipeline.",
  );
  const fixed = settleExitPolicy(after.signals, candles, "fixed_tp1");
  const runner = settleExitPolicy(after.signals, candles, LIVE_EXIT_POLICY);

  const fmtExit = (e: ReturnType<typeof settleExitPolicy>) => {
    const wr = e.winRate == null ? "n/a" : `${e.winRate.toFixed(1)}%`;
    const sl = e.slRate == null ? "n/a" : `${e.slRate.toFixed(1)}%`;
    const ar =
      e.avgR == null ? "n/a" : `${e.avgR >= 0 ? "+" : ""}${e.avgR.toFixed(3)}R`;
    return (
      `${e.policy.padEnd(22)} n=${String(e.n).padStart(4)}  WR=${wr.padStart(6)}  ` +
      `SL%=${sl.padStart(6)}  avgR=${ar.padStart(8)}  totalR=${e.totalR.toFixed(1).padStart(7)}  ` +
      `maxDD=${e.maxDrawdownR.toFixed(2)}`
    );
  };
  console.log(fmtExit(fixed));
  console.log(fmtExit(runner));
  if (fixed.totalR !== 0) {
    const lift = ((runner.totalR / fixed.totalR - 1) * 100).toFixed(1);
    console.log(
      `\nRunner vs fixed_tp1 on trusted AFTER set: totalR lift ${lift}%  ` +
        `(avgR ${fixed.avgR?.toFixed(3)} → ${runner.avgR?.toFixed(3)})`,
    );
  }

  // Diagnostic: how often bounce / fresh extreme would fire on BEFORE emissions
  // that AFTER rejects — count via re-checking is expensive; lock delta is enough.

  const payload = {
    methodology: {
      file: FILE,
      days: DAYS,
      spread: SPREAD,
      rejectAlreadyMissed: REJECT_ALREADY_MISSED,
      slPrioritySameBar: true,
      priorRunnerClaim:
        "NOT trusted pipeline — CSV + custom cooldown emitter + simulateExit",
    },
    entryGuards: { before: beforeFunnel, after: afterFunnel },
    dayRegimeOnAfter: {
      ...afterDay,
      blockedPause: dayFiltered.blockedPause,
      blockedChase: dayFiltered.blockedChase,
      blockedRetrace: dayFiltered.blockedRetrace,
      blockedSide: dayFiltered.blockedSide,
    },
    exitsOnAfterExecuted: { fixed, runner },
    elapsedSec: {
      before: before.elapsedSec,
      after: after.elapsedSec,
    },
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${OUT}`);
}

main();
