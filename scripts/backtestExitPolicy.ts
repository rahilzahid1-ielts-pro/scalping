/**
 * Exit-policy comparison — replay QS Pro signals over the M5 history and settle
 * the *same* signal set under each exit policy.
 *
 * Signal generation is untouched, so any difference is purely the exit rule.
 * `fixed_tp1` reproduces what the demo engine does today (full close at TP1).
 *
 *   npm run backtest:exits -- --days=365
 */
import { filterLastDays, loadHistoricalFile } from "../src/backtest/loadData";
import { framesAtIndex, precomputeHtfs } from "../src/backtest/frames";
import { windowStartIndex } from "../src/backtest/loadData";
import { generatePulseSignal } from "../src/strategies/pulseEngine";
import {
  buildExitPlan,
  isTrendRegime,
  simulateExit,
  type ExitPolicyId,
} from "../src/exits/exitPolicy";
import type { Candle } from "../src/types";

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt;

const file = argOf("file", "data/XAU_5m_data.csv");
const days = Number(argOf("days", "365"));
const spread = Number(argOf("spread", "0.25"));
const cooldown = Number(argOf("cooldown", "24"));

const POLICIES: ExitPolicyId[] = [
  "fixed_tp1",
  "scale_be",
  "runner_ladder",
  "runner_trail",
];

interface Emitted {
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  regime: string;
  index: number;
}

console.log(`Loading ${file} …`);
const loaded = loadHistoricalFile(file);
const m5: Candle[] = filterLastDays(loaded.candles, days);
console.log(`bars ${m5.length}  days ${days}  spread ${spread}`);

const htfs = precomputeHtfs(m5);
const start = Math.max(windowStartIndex(m5, days), 250);

// Pass 1 — emit the signal set once, with the SAME serialisation rule the live
// desk uses (one open plan at a time, cooldown between locks). Occupancy is
// decided by the cheapest policy so every policy scores the same signals.
const emitted: Emitted[] = [];
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
    spread > 0
      ? sig.direction === "BUY"
        ? sig.entry + spread
        : sig.entry - spread
      : sig.entry;
  const risk = Math.abs(sig.entry - sig.sl);
  const sl = sig.direction === "BUY" ? entry - risk : entry + risk;

  emitted.push({
    side: sig.direction,
    entry,
    sl,
    regime: sig.regime ?? "",
    index: i,
  });
  lastSignalIndex = i;

  // Reserve the bars the baseline plan would occupy so signals do not overlap.
  const basePlan = buildExitPlan({
    policy: "fixed_tp1",
    side: sig.direction,
    entry,
    sl,
    regime: sig.regime,
  });
  const baseRes = simulateExit(basePlan, m5, i + 1);
  busyUntil = i + 1 + baseRes.barsHeld;
}

const trendCount = emitted.filter((e) => isTrendRegime(e.regime)).length;
console.log(
  `\nsignals ${emitted.length}  (trend regime ${trendCount}, range ${emitted.length - trendCount})\n`,
);

interface Agg {
  n: number;
  totalR: number;
  wins: number;
  losses: number;
  flat: number;
  best: number;
  worst: number;
  equity: number;
  peakEquity: number;
  maxDd: number;
  trailExits: number;
}

const rows: { policy: ExitPolicyId; agg: Agg; trend: Agg; range: Agg }[] = [];

function newAgg(): Agg {
  return {
    n: 0,
    totalR: 0,
    wins: 0,
    losses: 0,
    flat: 0,
    best: -Infinity,
    worst: Infinity,
    equity: 0,
    peakEquity: 0,
    maxDd: 0,
    trailExits: 0,
  };
}

function add(a: Agg, r: number, trailed: boolean): void {
  a.n += 1;
  a.totalR += r;
  if (r > 1e-6) a.wins += 1;
  else if (r < -1e-6) a.losses += 1;
  else a.flat += 1;
  if (r > a.best) a.best = r;
  if (r < a.worst) a.worst = r;
  a.equity += r;
  if (a.equity > a.peakEquity) a.peakEquity = a.equity;
  const dd = a.equity - a.peakEquity;
  if (dd < a.maxDd) a.maxDd = dd;
  if (trailed) a.trailExits += 1;
}

for (const policy of POLICIES) {
  const agg = newAgg();
  const trend = newAgg();
  const range = newAgg();

  for (const e of emitted) {
    const plan = buildExitPlan({
      policy,
      side: e.side,
      entry: e.entry,
      sl: e.sl,
      regime: e.regime,
    });
    const res = simulateExit(plan, m5, e.index + 1);
    const trailed = res.exitKind === "TRAIL";
    add(agg, res.realizedR, trailed);
    add(isTrendRegime(e.regime) ? trend : range, res.realizedR, trailed);
  }

  rows.push({ policy, agg, trend, range });
}

const f = (n: number, d = 3) =>
  Number.isFinite(n) ? n.toFixed(d).padStart(8) : "     n/a";
const pct = (a: Agg) =>
  a.n ? `${((a.wins / a.n) * 100).toFixed(1).padStart(5)}%` : "   n/a";

console.log("policy          n     WR      avgR    totalR    maxDD     best    worst  trail");
console.log("-".repeat(84));
for (const r of rows) {
  console.log(
    `${r.policy.padEnd(14)} ${String(r.agg.n).padStart(4)} ${pct(r.agg)} ${f(
      r.agg.totalR / Math.max(1, r.agg.n),
    )} ${f(r.agg.totalR, 1)} ${f(r.agg.maxDd, 1)} ${f(r.agg.best, 1)} ${f(
      r.agg.worst,
      1,
    )}  ${String(r.agg.trailExits).padStart(4)}`,
  );
}

console.log("\nTREND-regime signals only");
console.log("policy          n     WR      avgR    totalR");
console.log("-".repeat(48));
for (const r of rows) {
  console.log(
    `${r.policy.padEnd(14)} ${String(r.trend.n).padStart(4)} ${pct(
      r.trend,
    )} ${f(r.trend.totalR / Math.max(1, r.trend.n))} ${f(r.trend.totalR, 1)}`,
  );
}

console.log("\nRANGE-regime signals only");
console.log("policy          n     WR      avgR    totalR");
console.log("-".repeat(48));
for (const r of rows) {
  console.log(
    `${r.policy.padEnd(14)} ${String(r.range.n).padStart(4)} ${pct(
      r.range,
    )} ${f(r.range.totalR / Math.max(1, r.range.n))} ${f(r.range.totalR, 1)}`,
  );
}
