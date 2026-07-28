/**
 * Final selection: hold bankFraction/bankRr at the high-hit-rate cell and pick
 * the peak-trail distance that holds up across several history windows.
 *
 *   npx tsx scripts/pickRunnerTune.ts
 */
import {
  filterLastDays,
  loadHistoricalFile,
  windowStartIndex,
} from "../src/backtest/loadData";
import { framesAtIndex, precomputeHtfs } from "../src/backtest/frames";
import { generatePulseSignal } from "../src/strategies/pulseEngine";
import {
  buildExitPlan,
  isTrendRegime,
  simulateExit,
  type ExitPolicyId,
  type RunnerTune,
} from "../src/exits/exitPolicy";
import type { Candle } from "../src/types";

const file = "data/XAU_5m_data.csv";
const spread = 0.25;
const cooldown = 24;
const WINDOWS = [180, 365, 730, 1460];
const PEAKS = [0.5, 0.8, 1.0, 1.25, 1.5, 2.0];

console.log(`Loading ${file} …`);
const all = loadHistoricalFile(file).candles;

interface Emitted {
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  regime: string;
  index: number;
}

function emit(m5: Candle[], days: number): Emitted[] {
  const htfs = precomputeHtfs(m5);
  const start = Math.max(windowStartIndex(m5, days), 250);
  const out: Emitted[] = [];
  let lastSignalIndex = -cooldown;
  let busyUntil = -1;
  for (let i = start; i < m5.length; i += 1) {
    if (i < busyUntil) continue;
    if (i - lastSignalIndex < cooldown) continue;
    const frames = framesAtIndex(m5, i, "scalping", htfs);
    if (!frames) continue;
    let sig;
    try {
      sig = generatePulseSignal(frames, "XAUUSD", "scalping");
    } catch {
      continue;
    }
    if (!sig) continue;
    const entry =
      sig.direction === "BUY" ? sig.entry + spread : sig.entry - spread;
    const risk = Math.abs(sig.entry - sig.sl);
    const sl = sig.direction === "BUY" ? entry - risk : entry + risk;
    out.push({ side: sig.direction, entry, sl, regime: sig.regime ?? "", index: i });
    lastSignalIndex = i;
    const base = buildExitPlan({
      policy: "fixed_tp1",
      side: sig.direction,
      entry,
      sl,
      regime: sig.regime,
    });
    busyUntil = i + 1 + simulateExit(base, m5, i + 1).barsHeld;
  }
  return out;
}

function score(
  m5: Candle[],
  sigs: Emitted[],
  policy: ExitPolicyId,
  tune?: RunnerTune,
) {
  let total = 0;
  let wins = 0;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const e of sigs) {
    const plan = buildExitPlan({
      policy,
      side: e.side,
      entry: e.entry,
      sl: e.sl,
      regime: e.regime,
      tune,
    });
    const r = simulateExit(plan, m5, e.index + 1).realizedR;
    total += r;
    if (r > 1e-6) wins += 1;
    equity += r;
    if (equity > peak) peak = equity;
    if (equity - peak < maxDd) maxDd = equity - peak;
  }
  const n = Math.max(1, sigs.length);
  return { n: sigs.length, wr: (wins / n) * 100, avgR: total / n, total, maxDd };
}

const tuneFor = (trailPeakR: number): RunnerTune => ({
  bankFraction: 0.3,
  bankRr: 1.0,
  trailBars: 8,
  trailPeakR,
});

for (const days of WINDOWS) {
  const m5 = filterLastDays(all, days);
  const sigs = emit(m5, days);
  const base = score(m5, sigs, "fixed_tp1");
  console.log(
    `\n=== ${days}d · ${sigs.length} signals (trend ${sigs.filter((s) => isTrendRegime(s.regime)).length}) ===`,
  );
  console.log(
    `  baseline fixed_tp1        WR ${base.wr.toFixed(1)}%  avgR ${base.avgR.toFixed(3)}  totalR ${base.total.toFixed(1)}  maxDD ${base.maxDd.toFixed(1)}`,
  );
  for (const p of PEAKS) {
    const s = score(m5, sigs, "runner_trail_peak", tuneFor(p));
    const lift = ((s.total / base.total - 1) * 100).toFixed(1);
    console.log(
      `  peak trail ${p.toFixed(2)}R          WR ${s.wr.toFixed(1)}%  avgR ${s.avgR.toFixed(3)}  totalR ${s.total.toFixed(1).padStart(6)}  maxDD ${s.maxDd.toFixed(1).padStart(6)}  ${lift.padStart(6)}%`,
    );
  }
}
