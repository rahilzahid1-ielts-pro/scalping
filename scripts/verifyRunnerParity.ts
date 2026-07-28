/**
 * Parity check: the live tick machine (`advanceRunnerOnPrice`, used by the demo
 * resolver) must settle plans the same way the measured walk-forward
 * (`simulateExit`) does. Each bar is replayed as adverse-extreme then
 * favourable-extreme then close, which is the tick order `simulateExit` assumes.
 *
 *   npx tsx scripts/verifyRunnerParity.ts --days=365
 */
import {
  filterLastDays,
  loadHistoricalFile,
  windowStartIndex,
} from "../src/backtest/loadData";
import { framesAtIndex, precomputeHtfs } from "../src/backtest/frames";
import { generatePulseSignal } from "../src/strategies/pulseEngine";
import {
  advanceRunnerOnPrice,
  buildExitPlan,
  initialRunnerState,
  LIVE_EXIT_POLICY,
  simulateExit,
} from "../src/exits/exitPolicy";
import type { Candle } from "../src/types";

const args = process.argv.slice(2);
const days = Number(
  args.find((a) => a.startsWith("--days="))?.split("=")[1] ?? "365",
);
const spread = 0.25;
const cooldown = 24;

const m5: Candle[] = filterLastDays(
  loadHistoricalFile("data/XAU_5m_data.csv").candles,
  days,
);
const htfs = precomputeHtfs(m5);
const start = Math.max(windowStartIndex(m5, days), 250);

let compared = 0;
let mismatch = 0;
let simTotal = 0;
let liveTotal = 0;
let worstDiff = 0;
const examples: string[] = [];

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
  lastSignalIndex = i;

  const side = sig.direction;
  const entry = side === "BUY" ? sig.entry + spread : sig.entry - spread;
  const risk = Math.abs(sig.entry - sig.sl);
  const sl = side === "BUY" ? entry - risk : entry + risk;
  const plan = buildExitPlan({
    policy: LIVE_EXIT_POLICY,
    side,
    entry,
    sl,
    regime: sig.regime,
  });

  const sim = simulateExit(plan, m5, i + 1);
  busyUntil = i + 1 + sim.barsHeld;

  // Live path: same plan, driven only by polled prices.
  let state = initialRunnerState(plan);
  let liveR: number | null = null;
  for (let j = i + 1; j < m5.length; j += 1) {
    const b = m5[j];
    const adverse = side === "BUY" ? b.low : b.high;
    const favourable = side === "BUY" ? b.high : b.low;
    let done = false;
    for (const px of [adverse, favourable, b.close]) {
      const step = advanceRunnerOnPrice(plan, state, px);
      state = step.state;
      if (step.closed) {
        liveR = step.closed.totalR;
        done = true;
        break;
      }
    }
    if (done) break;
  }
  if (liveR == null) continue; // still open at data end — skip

  compared += 1;
  simTotal += sim.realizedR;
  liveTotal += liveR;
  const diff = Math.abs(sim.realizedR - liveR);
  if (diff > worstDiff) worstDiff = diff;
  if (diff > 0.02) {
    mismatch += 1;
    if (examples.length < 6) {
      examples.push(
        `  bar ${i} ${side} entry ${entry.toFixed(2)}  sim ${sim.realizedR.toFixed(3)} (${sim.exitKind})  live ${liveR.toFixed(3)}  Δ${diff.toFixed(3)}`,
      );
    }
  }
}

console.log(`policy        ${LIVE_EXIT_POLICY}`);
console.log(`compared      ${compared}`);
console.log(`sim totalR    ${simTotal.toFixed(2)}  (avg ${(simTotal / compared).toFixed(4)})`);
console.log(`live totalR   ${liveTotal.toFixed(2)}  (avg ${(liveTotal / compared).toFixed(4)})`);
console.log(`totalR drift  ${(liveTotal - simTotal).toFixed(2)}  (${(((liveTotal - simTotal) / Math.abs(simTotal)) * 100).toFixed(2)}%)`);
console.log(`per-trade mismatches >0.02R: ${mismatch}  worst Δ ${worstDiff.toFixed(3)}R`);
if (examples.length) {
  console.log("examples:");
  for (const e of examples) console.log(e);
}
