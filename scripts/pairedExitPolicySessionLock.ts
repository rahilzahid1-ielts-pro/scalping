/**
 * True paired A-vs-A' exit-policy test on the trusted session-lock pipeline.
 *
 * Same resolver (`advanceSignalOnBar`), same QS Pro executed trade set, only
 * `exitPolicy` differs:
 *   A  = fixed_tp1          (100% at plan TP1 — keep/compare R)
 *   A' = runner_trail_peak  (bank / BE / peak trail inside the same resolver)
 *
 * Trade set is taken from one legacy session-lock walk (occupancy unchanged).
 * Each executed row is then replayed from its zone-touch bar twice.
 *
 *   npx tsx scripts/pairedExitPolicySessionLock.ts
 *   npx tsx scripts/pairedExitPolicySessionLock.ts \
 *     --start=2024-01-30T23:55:00.000Z --end=2025-01-30T23:55:00.000Z \
 *     --out=data/_paired_exit_policy_w2.json
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
import {
  runWalkForward,
  type SessionLockCandidateFn,
} from "../src/backtest/engine";
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
import { rAtPrice } from "../src/exits/exitPolicy";

const DEFAULT_FILE = "C:/scalping/data/XAUUSD_M5.json";
const SPREAD = 0.25;
const DAYS = 365;
const ASSET: AssetId = "XAUUSD";
/** Same warmup as Fractal robustness / compareFractalSessionLock. */
const WARMUP_MS = 120 * 24 * 60 * 60 * 1000;

function argValue(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

function sliceWindow(all: Candle[], startIso: string, endIso: string) {
  const windowStartMs = Date.parse(startIso);
  const windowEndMs = Date.parse(endIso);
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) {
    throw new Error(`Bad window dates: ${startIso} → ${endIso}`);
  }
  const candles = all.filter(
    (c) => c.time >= windowStartMs - WARMUP_MS && c.time <= windowEndMs,
  );
  const windowStartIdx = candles.findIndex((c) => c.time >= windowStartMs);
  if (windowStartIdx < 0) throw new Error(`No bars in window ${startIso}`);
  return { candles, windowStartIdx, windowStartMs, windowEndMs };
}

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
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
  return openBacktestDb(true);
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
    const periodMs =
      i + 1 < candles.length
        ? candles[i + 1].time - candles[i].time
        : 5 * 60 * 1000;
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
  if (sig.outcomeTp1 == null) {
    // Never resolved — mark full position at last close (honest open)
    return Math.round(rAtPrice(sig.side, sig.entry, risk, close) * 1000) / 1000;
  }
  const remR = rem * rAtPrice(sig.side, sig.entry, risk, close);
  return Math.round((banked + remR) * 1000) / 1000;
}

function replayPolicy(
  executed: LoggedSignal[],
  candles: Candle[],
  policy: AdvanceExitPolicy,
): {
  n: number;
  wins: number;
  losses: number;
  rs: number[];
  keys: string[];
  skipped: number;
  openAtEnd: number;
} {
  const idx = buildCloseTimeIndex(candles);
  const rs: number[] = [];
  const keys: string[] = [];
  let wins = 0;
  let losses = 0;
  let skipped = 0;
  let openAtEnd = 0;

  for (const src of executed) {
    const i0 = idx.get(src.zoneTouchedAt!);
    if (i0 == null) {
      skipped += 1;
      continue;
    }
    keys.push(tradeKey(src));
    let sig = seedOpen(src);
    // zoneTouchedAt already set — entry is active from i0
    for (let i = i0; i < candles.length; i++) {
      const bar = candles[i];
      const periodMs =
        i + 1 < candles.length
          ? candles[i + 1].time - bar.time
          : 5 * 60 * 1000;
      const asOfClose = bar.time + periodMs;
      const tick = {
        price: bar.close,
        open: bar.open,
        high: bar.high,
        low: bar.low,
      };
      const next = advanceSignalOnBar(sig, tick, asOfClose, { exitPolicy: policy });
      if (next) sig = next as AdvancingSignal;
      if (sig.fullPlanClosed) break;
    }

    let r: number;
    if (sig.fullPlanClosed && sig.realizedR != null) {
      r = sig.realizedR;
    } else {
      openAtEnd += 1;
      r = markToMarket(sig, candles[candles.length - 1].close);
    }
    rs.push(r);
    if (r > 1e-6) wins += 1;
    else if (r < -1e-6) losses += 1;
  }

  return { n: rs.length, wins, losses, rs, keys, skipped, openAtEnd };
}

function maxDdFromRs(rs: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of rs) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = equity - peak;
    if (dd < maxDd) maxDd = dd;
  }
  return Math.abs(maxDd);
}

function summarize(
  label: string,
  replay: ReturnType<typeof replayPolicy>,
) {
  const { n, wins, losses, rs } = replay;
  const totalR = rs.reduce((a, b) => a + b, 0);
  return {
    label,
    n,
    wins,
    losses,
    winRate: n ? (wins / n) * 100 : null,
    slRate: n ? (losses / n) * 100 : null,
    avgR: n ? totalR / n : null,
    totalR,
    maxDd: maxDdFromRs(rs),
    skipped: replay.skipped,
    openAtEnd: replay.openAtEnd,
    setHash: setHash(replay.keys),
  };
}

function fmt(s: ReturnType<typeof summarize>) {
  const wr = s.winRate == null ? "n/a" : `${s.winRate.toFixed(1)}%`;
  const sl = s.slRate == null ? "n/a" : `${s.slRate.toFixed(1)}%`;
  const ar =
    s.avgR == null ? "n/a" : `${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(3)}R`;
  return (
    `${s.label.padEnd(22)} n=${String(s.n).padStart(4)}  WR=${wr.padStart(6)}  ` +
    `SL%=${sl.padStart(6)}  avgR=${ar.padStart(8)}  totalR=${s.totalR.toFixed(1).padStart(7)}  ` +
    `maxDD=${s.maxDd.toFixed(2)}`
  );
}

function lockTp1Baseline(executed: LoggedSignal[]) {
  const rs: number[] = [];
  let wins = 0;
  let losses = 0;
  for (const s of executed) {
    if (s.realizedR == null || !Number.isFinite(s.realizedR)) continue;
    rs.push(s.realizedR);
    if (s.outcomeTp1 === "WIN") wins += 1;
    else losses += 1;
  }
  const totalR = rs.reduce((a, b) => a + b, 0);
  return {
    label: "lock realizedR (ref)",
    n: rs.length,
    wins,
    losses,
    winRate: rs.length ? (wins / rs.length) * 100 : null,
    slRate: rs.length ? (losses / rs.length) * 100 : null,
    avgR: rs.length ? totalR / rs.length : null,
    totalR,
    maxDd: maxDdFromRs(rs),
    skipped: 0,
    openAtEnd: 0,
    setHash: setHash(executed.map(tradeKey)),
  };
}

function main() {
  const FILE = argValue("--file") ?? DEFAULT_FILE;
  if (!existsSync(FILE)) {
    console.error(`Missing ${FILE}`);
    process.exit(1);
  }
  setWaitingTooLateMode("legacy_nested");

  const startIso = argValue("--start");
  const endIso = argValue("--end");
  const outPath =
    argValue("--out") ??
    (startIso
      ? "data/_paired_exit_policy_w2.json"
      : "data/_paired_exit_policy_session_lock.json");

  console.log(`Loading ${FILE}…`);
  const loaded = loadHistoricalFile(FILE);
  let candles = loaded.candles;
  let winStart = windowStartIndex(candles, DAYS);
  let windowLabel = `last ${DAYS}d (idx ${winStart} → end)`;

  if (startIso && endIso) {
    const sliced = sliceWindow(loaded.candles, startIso, endIso);
    candles = sliced.candles;
    winStart = sliced.windowStartIdx;
    windowLabel = `${startIso} → ${endIso}`;
  } else if (startIso || endIso) {
    console.error("Provide both --start= and --end= ISO timestamps");
    process.exit(1);
  }

  console.log(`
════════════════════════════════════════════════════════════════════════
PAIRED A vs A' — advanceSignalOnBar exitPolicy (trusted session-lock)
════════════════════════════════════════════════════════════════════════
File / spread / B-state : ${FILE} / ${SPREAD} / rejectAlreadyMissed=true
Window                  : ${windowLabel}
Bars / windowStartIdx   : ${candles.length} / ${winStart}
Resolver                : advanceSignalOnBar (same function both arms)
Trade set               : one legacy WF; replay only (occupancy fixed)
A  = fixed_tp1          : 100% at plan TP1
A' = runner_trail_peak  : bank/BE/peak trail inside same resolver
`);

  const db = resetDb();
  const t0 = Date.now();
  runWalkForward(db, candles, {
    assetId: ASSET,
    modes: ["scalping"],
    spread: SPREAD,
    windowStartIdx: winStart,
    trendConfirmBars: 4,
    rejectAlreadyMissed: true,
    signalCandidate: QS_PRO,
    onProgress: (done, total) => {
      if (done === 0 || done === total || done % 15000 === 0) {
        process.stdout.write(
          `\r  QS Pro lock ${done}/${total} (${((done / Math.max(1, total)) * 100).toFixed(0)}%)   `,
        );
      }
    },
  });
  process.stdout.write("\n");
  const signals = listBacktestSignals(db);
  closeBacktestDb();
  console.log(`  walk done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const executed = signals.filter(
    (s) =>
      s.zoneTouchedAt != null &&
      (s.outcomeTp1 === "WIN" || s.outcomeTp1 === "LOSS"),
  );

  const ref = lockTp1Baseline(executed);
  const a = summarize(
    "A  fixed_tp1",
    replayPolicy(executed, candles, "fixed_tp1"),
  );
  const ap = summarize(
    "A' runner_trail_peak",
    replayPolicy(executed, candles, "runner_trail_peak"),
  );

  const sameSet = a.setHash === ap.setHash && a.n === ap.n;
  const aMatchesLock =
    Math.abs((a.avgR ?? 0) - (ref.avgR ?? 0)) < 1e-6 && a.n === ref.n;

  const deltaAvg =
    a.avgR != null && ap.avgR != null ? ap.avgR - a.avgR : null;
  const deltaTotal = ap.totalR - a.totalR;
  const pctTotal = a.totalR !== 0 ? (deltaTotal / Math.abs(a.totalR)) * 100 : null;

  console.log("\n── Comparable table (same trade keys, same resolver) ──\n");
  console.log(fmt(ref));
  console.log(fmt(a));
  console.log(fmt(ap));
  console.log("");
  console.log(`Trade-set hash A / A' : ${a.setHash} / ${ap.setHash}  same=${sameSet}`);
  console.log(
    `A vs lock realizedR   : avgR match=${aMatchesLock} (fixed_tp1 should equal keep/compare TP1 R)`,
  );
  console.log(
    `A' − A                : ΔavgR=${deltaAvg == null ? "n/a" : (deltaAvg >= 0 ? "+" : "") + deltaAvg.toFixed(3)}  ` +
      `ΔtotalR=${deltaTotal >= 0 ? "+" : ""}${deltaTotal.toFixed(1)}  ` +
      `(${pctTotal == null ? "n/a" : (pctTotal >= 0 ? "+" : "") + pctTotal.toFixed(1) + "% totalR"})`,
  );
  console.log(
    `Open-at-end mark-to-mkt: A=${a.openAtEnd}  A'=${ap.openAtEnd}  skipped=${a.skipped}`,
  );

  const verdict =
    !sameSet
      ? "INVALID — trade sets diverged"
      : !aMatchesLock
        ? "CHECK — fixed_tp1 replay diverged from lock realizedR"
        : deltaAvg != null && deltaAvg > 0 && ap.maxDd <= a.maxDd + 1.5
          ? "RUNNER HELPS on this paired bar — candidate to re-enable live after review"
          : deltaAvg != null && deltaAvg > 0
            ? "RUNNER lifts avgR but check drawdown before live"
            : "NO CLEAR BENEFIT — keep runner paused in production";

  console.log(`\nVerdict: ${verdict}\n`);

  const payload = {
    methodology: {
      file: FILE,
      window: windowLabel,
      startIso: startIso ?? null,
      endIso: endIso ?? null,
      days: startIso ? null : DAYS,
      spread: SPREAD,
      rejectAlreadyMissed: true,
      resolver: "advanceSignalOnBar",
      tradeSet: "legacy session-lock QS Pro executed; replay only",
      A: "fixed_tp1",
      A_prime: "runner_trail_peak",
    },
    ref,
    A: a,
    A_prime: ap,
    delta: { avgR: deltaAvg, totalR: deltaTotal, pctTotalR: pctTotal },
    sameSet,
    aMatchesLock,
    verdict,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${outPath}`);
}

main();
