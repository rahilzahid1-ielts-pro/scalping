/**
 * READ-ONLY verification — does not change production engines or demo wiring.
 *
 * Reconciles the conflicting avgR/maxDD on the QS Pro AFTER n=198 set, then
 * runs the same trusted session-lock + exit-policy comparison for Cipher B and
 * Pro. Also documents whether gateLearnedLock is in the walk-forward path.
 *
 *   npx tsx scripts/reconcileTrustedMetrics.ts
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadHistoricalFile, windowStartIndex } from "../src/backtest/loadData";
import {
  closeBacktestDb,
  getBacktestDbPath,
  listBacktestSignals,
  openBacktestDb,
} from "../src/backtest/store";
import {
  runWalkForward,
  type SessionLockCandidateFn,
} from "../src/backtest/engine";
import type { AssetId, Candle, LiveSignal, TradeLevels, TradeMode } from "../src/types";
import { generateSignal } from "../src/strategies/signalEngine";
import { generatePulseSignal } from "../src/strategies/pulseEngine";
import { generateCipherBLiveSignal } from "../src/strategies/cipherBLive";
import { generateProSignal } from "../src/strategies/proEngine";
import { setWaitingTooLateMode } from "../src/services/tradePlan";
import {
  buildExitPlan,
  LIVE_EXIT_POLICY,
  simulateExit,
  type ExitPolicyId,
} from "../src/exits/exitPolicy";
import type { LoggedSignal } from "../src/calibration/types";
import { gateLearnedLock } from "../src/learn/runtime";

const FILE = "C:/scalping/data/XAUUSD_M5.json";
const OUT = "data/_reconcile_trusted_metrics.json";
const SPREAD = 0.25;
const DAYS = 365;
const ASSET: AssetId = "XAUUSD";

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

function candidate(
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

function runModule(
  label: string,
  mode: TradeMode,
  cand: SessionLockCandidateFn,
  candles: Candle[],
  windowStartIdx: number,
) {
  const db = resetDb();
  const t0 = Date.now();
  runWalkForward(db, candles, {
    assetId: ASSET,
    modes: [mode],
    spread: SPREAD,
    windowStartIdx,
    trendConfirmBars: 4,
    rejectAlreadyMissed: true,
    signalCandidate: cand,
    onProgress: (done, total) => {
      if (done === 0 || done === total || done % 20000 === 0) {
        process.stdout.write(
          `\r  ${label} ${done}/${total} (${((done / Math.max(1, total)) * 100).toFixed(0)}%)   `,
        );
      }
    },
  });
  process.stdout.write("\n");
  return {
    label,
    signals: listBacktestSignals(db),
    elapsedSec: (Date.now() - t0) / 1000,
  };
}

function executedTp1(signals: LoggedSignal[]): LoggedSignal[] {
  return signals
    .filter(
      (s) =>
        s.zoneTouchedAt != null &&
        (s.outcomeTp1 === "WIN" || s.outcomeTp1 === "LOSS"),
    )
    .sort(
      (a, b) =>
        (a.zoneTouchedAt ?? a.timestamp) - (b.zoneTouchedAt ?? b.timestamp),
    );
}

function tradeKey(s: LoggedSignal): string {
  return `${s.side}|${s.entry}|${s.sl}|${s.tp1}|${s.zoneTouchedAt}|${s.timestamp}`;
}

function setHash(keys: string[]): string {
  return createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 16);
}

function maxDdFromRs(rs: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of rs) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return Math.round(maxDd * 1000) / 1000;
}

function statsFromRs(rs: number[], wins: number, losses: number) {
  const n = rs.length;
  const total = rs.reduce((a, b) => a + b, 0);
  return {
    n,
    wins,
    losses,
    winRate: n ? (wins / n) * 100 : null,
    slRate: n ? (losses / n) * 100 : null,
    avgR: n ? total / n : null,
    totalR: total,
    maxDd: maxDdFromRs(rs),
  };
}

/** Strict TP1-R from session-lock rows (advanceSignalOnBar `realizedR`). */
function strictTp1FromLock(executed: LoggedSignal[]) {
  const rs: number[] = [];
  let wins = 0;
  let losses = 0;
  let missing = 0;
  for (const s of executed) {
    if (s.realizedR == null || !Number.isFinite(s.realizedR)) {
      missing += 1;
      continue;
    }
    rs.push(s.realizedR);
    if (s.outcomeTp1 === "WIN") wins += 1;
    else losses += 1;
  }
  return { ...statsFromRs(rs, wins, losses), missing, keys: executed.map(tradeKey) };
}

/** Full-plan R from session-lock (`realizedRFull` — 1/3 TP1/TP2/TP3 scale). */
function fullPlanFromLock(executed: LoggedSignal[]) {
  const rs: number[] = [];
  let wins = 0;
  let losses = 0;
  let missing = 0;
  for (const s of executed) {
    const r = s.realizedRFull ?? s.realizedR;
    if (r == null || !Number.isFinite(r)) {
      missing += 1;
      continue;
    }
    rs.push(r);
    if (s.outcomeTp1 === "WIN") wins += 1;
    else losses += 1;
  }
  return { ...statsFromRs(rs, wins, losses), missing };
}

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

/**
 * simulateExit settlement — THIS is what the prior exit-policy table used.
 * Starts at bar AFTER zone-touch stamp (i+1). Not identical to advanceSignalOnBar.
 */
function simulatePolicy(
  executed: LoggedSignal[],
  candles: Candle[],
  policy: ExitPolicyId,
) {
  const idx = buildCloseTimeIndex(candles);
  const rs: number[] = [];
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  const keys: string[] = [];
  for (const s of executed) {
    const i = idx.get(s.zoneTouchedAt!);
    if (i == null) {
      skipped += 1;
      continue;
    }
    keys.push(tradeKey(s));
    const plan = buildExitPlan({
      policy,
      side: s.side,
      entry: s.entry,
      sl: s.sl,
      regime: s.regime,
    });
    const res = simulateExit(plan, candles, i + 1);
    rs.push(res.realizedR);
    if (res.realizedR > 1e-6) wins += 1;
    else if (res.realizedR < -1e-6) losses += 1;
  }
  return { ...statsFromRs(rs, wins, losses), skipped, keys };
}

/**
 * Trusted runner baseline: for each lock-executed trade, compare
 *   - strict session-lock TP1 R (realizedR)
 *   - simulateExit(runner_trail_peak) on the same trade keys
 * So the delta is against the SAME trade set identity, with an honest note that
 * runner R comes from the tick/bar simulator while baseline R comes from the
 * session-lock resolver (the project's keep/compare TP1 convention).
 */
function fmt(s: {
  n: number;
  winRate: number | null;
  slRate: number | null;
  avgR: number | null;
  totalR: number;
  maxDd: number;
}) {
  const wr = s.winRate == null ? "n/a" : `${s.winRate.toFixed(1)}%`;
  const sl = s.slRate == null ? "n/a" : `${s.slRate.toFixed(1)}%`;
  const ar =
    s.avgR == null ? "n/a" : `${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(3)}R`;
  return (
    `n=${String(s.n).padStart(4)}  WR=${wr.padStart(6)}  SL%=${sl.padStart(6)}  ` +
    `avgR=${ar.padStart(8)}  totalR=${s.totalR.toFixed(1).padStart(7)}  maxDD=${s.maxDd.toFixed(2)}`
  );
}

function main() {
  if (!existsSync(FILE)) {
    console.error(`Missing ${FILE}`);
    process.exit(1);
  }
  setWaitingTooLateMode("legacy_nested");

  // --- ML gate presence check (static) ---
  const learnProbe = gateLearnedLock({
    module: "qs_pro",
    side: "SELL",
    entry: 4000,
    sl: 4010,
    tp1: 3990,
    at: Date.now(),
  });
  console.log(`
════════════════════════════════════════════════════════════════════════
RECONCILE + Cipher/Pro (read-only; no production changes)
════════════════════════════════════════════════════════════════════════
File / days / spread / B-state : ${FILE} / ${DAYS} / ${SPREAD} / rejectAlreadyMissed=true

gateLearnedLock in session-lock walk-forward?
  → NO. runWalkForward never calls gateNewLock / gateLearnedLock.
  → Live production DOES call gateLearnedLock inside gateNewLock.
  → Probe call returned ok=${learnProbe.ok} reason="${learnProbe.reason}"
    (function is loadable; it is simply not wired into the backtest path.)
`);

  const loaded = loadHistoricalFile(FILE);
  const candles = loaded.candles;
  const winStart = windowStartIndex(candles, DAYS);

  const qs = runModule(
    "QS Pro",
    "scalping",
    candidate((frames, mode, assetId) => {
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
    candles,
    winStart,
  );

  const executed = executedTp1(qs.signals);
  const lockTp1 = strictTp1FromLock(executed);
  const lockFull = fullPlanFromLock(executed);
  const simFixed = simulatePolicy(executed, candles, "fixed_tp1");
  const simRunner = simulatePolicy(executed, candles, LIVE_EXIT_POLICY);

  const hashLock = setHash(lockTp1.keys);
  const hashSim = setHash(simFixed.keys);
  const sameSet = hashLock === hashSim && lockTp1.n === simFixed.n;

  console.log("── Discrepancy root cause (QS Pro AFTER, same walk) ──\n");
  console.log(
    "Entry-guards table avgR=+0.110 used session-lock `realizedR` (strict TP1 R).",
  );
  console.log(
    "Entry-guards table maxDD=10.03 used session-lock `equityR`, which accumulates",
  );
  console.log(
    "  `realizedRFull ?? realizedR` (1/3 scale-out full-plan R) — NOT strict TP1.",
  );
  console.log(
    "Exit-policy fixed_tp1 row used simulateExit(fixed_tp1) from bar AFTER zone-touch,",
  );
  console.log(
    "  which is a DIFFERENT resolver than advanceSignalOnBar (can flip WR/SL counts).",
  );
  console.log("");
  console.log(`Trade-set hash (lock keys) : ${hashLock}`);
  console.log(`Trade-set hash (sim keys)  : ${hashSim}`);
  console.log(`Same trade identity set?   : ${sameSet ? "YES" : "NO"}`);
  console.log(`n lockTp1=${lockTp1.n}  n simFixed=${simFixed.n}  skippedSim=${simFixed.skipped}`);
  console.log("");

  console.log("── SAME n trades, THREE conventions side-by-side ──\n");
  console.log(
    `A  session-lock strict TP1 R     ${fmt(lockTp1)}`,
  );
  console.log(
    `B  session-lock full-plan R      ${fmt(lockFull)}   ← what equityR/maxDD mixed in`,
  );
  console.log(
    `C  simulateExit fixed_tp1        ${fmt(simFixed)}   ← prior exit-table baseline`,
  );
  console.log(
    `D  simulateExit runner_trail     ${fmt(simRunner)}`,
  );
  console.log("");
  console.log(
    "RECONCILED CLAIM (pick ONE baseline for the runner delta):",
  );
  console.log(
    `  vs C (sim fixed_tp1): totalR ${simFixed.totalR.toFixed(1)} → ${simRunner.totalR.toFixed(1)}  ` +
      `lift ${((simRunner.totalR / Math.max(1e-9, simFixed.totalR) - 1) * 100).toFixed(1)}%  ` +
      `avgR ${simFixed.avgR?.toFixed(3)} → ${simRunner.avgR?.toFixed(3)}`,
  );
  console.log(
    `  vs A (lock TP1 R):    totalR ${lockTp1.totalR.toFixed(1)} → ${simRunner.totalR.toFixed(1)}  ` +
      `lift ${((simRunner.totalR / Math.max(1e-9, lockTp1.totalR) - 1) * 100).toFixed(1)}%  ` +
      `(NOTE: A and D use different resolvers — apples-to-oranges for WR; totalR still informative)`,
  );
  console.log(
    "\nTrusted keep/compare convention for THIS project is A (session-lock TP1).",
  );
  console.log(
    "Runner cannot be expressed inside advanceSignalOnBar without code changes;",
  );
  console.log(
    "so the honest paired comparison for the runner is C→D (both simulateExit).",
  );
  console.log(
    "Do NOT quote +63.8% against the +0.110 lock-TP1 number — that mixed conventions.",
  );

  // ── Cipher B + Pro ──
  const modules: {
    label: string;
    mode: TradeMode;
    cand: SessionLockCandidateFn;
  }[] = [
    {
      label: "Cipher B",
      mode: "scalping",
      cand: candidate((frames, mode, assetId) => {
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
    {
      label: "Pro",
      mode: "intraday",
      cand: candidate((frames, mode, assetId) => {
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
  ];

  const perModule: Record<string, unknown> = {};

  console.log("\n── Cipher B / Pro — trusted session-lock + simulateExit exits ──");
  console.log(
    "(Entry bounce/fresh-extreme are QS Pro/Fractal-only; Cipher/Pro engines unchanged.",
  );
  console.log(
    " This table is current engine → lock TP1 vs sim fixed_tp1 vs sim runner.)\n",
  );

  for (const m of modules) {
    const run = runModule(m.label, m.mode, m.cand, candles, winStart);
    const ex = executedTp1(run.signals);
    const a = strictTp1FromLock(ex);
    const c = simulatePolicy(ex, candles, "fixed_tp1");
    const d = simulatePolicy(ex, candles, LIVE_EXIT_POLICY);
    const lift =
      c.totalR !== 0
        ? ((d.totalR / c.totalR - 1) * 100).toFixed(1)
        : "n/a";
    console.log(`${m.label}`);
    console.log(`  A lock TP1 R     ${fmt(a)}`);
    console.log(`  C sim fixed_tp1  ${fmt(c)}`);
    console.log(`  D sim runner     ${fmt(d)}   lift vs C: ${lift}%`);
    console.log(
      `  setHash=${setHash(a.keys)}  n=${a.n}  elapsed=${run.elapsedSec.toFixed(1)}s\n`,
    );
    perModule[m.label] = {
      lockTp1: a,
      simFixed: c,
      simRunner: d,
      liftPctVsSimFixed: lift,
      elapsedSec: run.elapsedSec,
    };
  }

  const payload = {
    mlGate: {
      inWalkForward: false,
      inLiveGateNewLock: true,
      probeOk: learnProbe.ok,
      probeReason: learnProbe.reason,
    },
    qsPro: {
      n: executed.length,
      sameTradeSet: sameSet,
      hashLock,
      hashSim,
      conventionA_lockStrictTp1: lockTp1,
      conventionB_lockFullPlan: lockFull,
      conventionC_simFixedTp1: simFixed,
      conventionD_simRunner: simRunner,
      reconciledRunnerLiftVsC:
        simFixed.totalR !== 0
          ? ((simRunner.totalR / simFixed.totalR - 1) * 100)
          : null,
      note:
        "Prior +63.8% was C→D. Entry table +0.110 was A. Mixing A with D is invalid.",
    },
    cipherAndPro: perModule,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${OUT}`);
}

main();
