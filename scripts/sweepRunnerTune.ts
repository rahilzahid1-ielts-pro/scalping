/**
 * Grid-search the trend runner on the same QS Pro signal set.
 * Baseline row is `fixed_tp1` (what the demo engine did before the runner).
 *
 * `runner_trail` needs bar history; `runner_trail_peak` needs only a polled
 * price, which is all the live demo resolver gets. Both are measured so we ship
 * the one we actually verified.
 *
 *   npm run backtest:exits:sweep -- --days=365
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

const args = process.argv.slice(2);
const argOf = (n: string, d: string) =>
  args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;

const file = argOf("file", "data/XAU_5m_data.csv");
const days = Number(argOf("days", "365"));
const spread = Number(argOf("spread", "0.25"));
const cooldown = Number(argOf("cooldown", "24"));

console.log(`Loading ${file} … (days=${days})`);
const m5: Candle[] = filterLastDays(loadHistoricalFile(file).candles, days);
const htfs = precomputeHtfs(m5);
const start = Math.max(windowStartIndex(m5, days), 250);

interface Emitted {
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  regime: string;
  index: number;
}

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
  emitted.push({ side: sig.direction, entry, sl, regime: sig.regime ?? "", index: i });
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

console.log(
  `signals ${emitted.length} (trend ${emitted.filter((e) => isTrendRegime(e.regime)).length})\n`,
);

function score(policy: ExitPolicyId, tune?: RunnerTune) {
  let total = 0;
  let wins = 0;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let best = -Infinity;
  for (const e of emitted) {
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
    if (r > best) best = r;
    equity += r;
    if (equity > peak) peak = equity;
    if (equity - peak < maxDd) maxDd = equity - peak;
  }
  const n = emitted.length;
  return { n, wr: (wins / n) * 100, avgR: total / n, total, maxDd, best };
}

const base = score("fixed_tp1");
console.log(
  `BASELINE fixed_tp1   WR ${base.wr.toFixed(1)}%  avgR ${base.avgR.toFixed(3)}  totalR ${base.total.toFixed(1)}  maxDD ${base.maxDd.toFixed(1)}\n`,
);

type Row = {
  policy: ExitPolicyId;
  tune: RunnerTune;
  s: ReturnType<typeof score>;
};
const rows: Row[] = [];

for (const bankFraction of [0.3, 0.4, 0.5]) {
  for (const bankRr of [0.85, 1.0, 1.25]) {
    for (const trailBars of [6, 8, 10]) {
      const tune: RunnerTune = { bankFraction, bankRr, trailBars, trailPeakR: 0.8 };
      rows.push({ policy: "runner_trail", tune, s: score("runner_trail", tune) });
    }
    for (const trailPeakR of [0.5, 0.8, 1.0, 1.5]) {
      const tune: RunnerTune = { bankFraction, bankRr, trailBars: 8, trailPeakR };
      rows.push({
        policy: "runner_trail_peak",
        tune,
        s: score("runner_trail_peak", tune),
      });
    }
  }
}

rows.sort((a, b) => b.s.total - a.s.total);

const line = (r: Row) => {
  const lift = ((r.s.total / base.total - 1) * 100).toFixed(1);
  const knob =
    r.policy === "runner_trail_peak"
      ? `peak ${r.tune.trailPeakR.toFixed(2)}R`
      : `swing ${r.tune.trailBars}b`;
  return `${r.policy.padEnd(18)} bank ${(r.tune.bankFraction * 100).toFixed(0).padStart(2)}% @ ${r.tune.bankRr.toFixed(2)}R  ${knob.padEnd(11)}  WR ${r.s.wr.toFixed(1).padStart(5)}%  avgR ${r.s.avgR.toFixed(3)}  totalR ${r.s.total.toFixed(1).padStart(6)}  maxDD ${r.s.maxDd.toFixed(1).padStart(6)}  best ${r.s.best.toFixed(1).padStart(5)}  ${lift.padStart(6)}%`;
};

console.log("TOP 12 overall");
console.log("-".repeat(130));
for (const r of rows.slice(0, 12)) console.log(line(r));

console.log("\nBEST per policy");
console.log("-".repeat(130));
for (const p of ["runner_trail", "runner_trail_peak"] as ExitPolicyId[]) {
  const b = rows.find((r) => r.policy === p);
  if (b) console.log(line(b));
}

console.log("\nWORST 4 (floor check — should still beat baseline)");
console.log("-".repeat(130));
for (const r of rows.slice(-4)) console.log(line(r));
