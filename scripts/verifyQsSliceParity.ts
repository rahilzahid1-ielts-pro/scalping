/**
 * Clean A/B: full M5 series vs filterLastDays — in-memory Quick Scalp walk.
 * No SQLite (avoids cross-run contamination). Same engine + frames + resolve rules.
 *
 *   npx tsx scripts/verifyQsSliceParity.ts [--days=45] [--spread=0.25]
 */
import { writeFileSync } from "node:fs";
import {
  loadHistoricalFile,
  filterLastDays,
  windowStartIndex,
} from "../src/backtest/loadData";
import {
  framesAtIndex,
  precomputeHtfs,
  onlyFullyClosed,
  type PrefetchedHtfs,
} from "../src/backtest/frames";
import { generateQuickScalpSignal } from "../src/strategies/quickScalpEngine";
import type { Candle } from "../src/types";

const M5 = "data/XAU_5m_data.csv";
const M15_MS = 15 * 60 * 1000;
const H1_MS = 60 * 60 * 1000;
const D1_MS = 24 * 60 * 60 * 1000;
const COOLDOWN = 24;
const RR_TP1 = 0.85;

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

type Trade = {
  t: number;
  dir: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  outcome: "TP1_HIT" | "SL_HIT" | "OPEN";
  realizedR: number | null;
};

function applySpread(side: "BUY" | "SELL", entry: number, spread: number): number {
  if (spread <= 0) return entry;
  return side === "BUY" ? entry + spread : entry - spread;
}

function resolveFrom(
  dir: "BUY" | "SELL",
  sl: number,
  tp1: number,
  bars: Candle[],
  from: number,
): { outcome: "TP1_HIT" | "SL_HIT"; at: number } | null {
  const buy = dir === "BUY";
  for (let i = from; i < bars.length; i++) {
    const b = bars[i];
    const hitSl = buy ? b.low <= sl : b.high >= sl;
    const hitTp = buy ? b.high >= tp1 : b.low <= tp1;
    // SL priority on same bar — trusted methodology
    if (hitSl && hitTp) return { outcome: "SL_HIT", at: b.time };
    if (hitSl) return { outcome: "SL_HIT", at: b.time };
    if (hitTp) return { outcome: "TP1_HIT", at: b.time };
  }
  return null;
}

/** Same walk logic as runQuickScalpBacktest, returns trades in-memory. */
function walkQs(candles: Candle[], days: number, spread: number): Trade[] {
  const start = windowStartIndex(candles, days);
  const htfs: PrefetchedHtfs = precomputeHtfs(candles);
  const trades: Trade[] = [];
  let open: { trade: Trade; from: number } | null = null;
  let lastSig = -COOLDOWN;

  for (let i = Math.max(start, 250); i < candles.length; i++) {
    if (open) {
      const res = resolveFrom(
        open.trade.dir,
        open.trade.sl,
        open.trade.tp1,
        candles,
        open.from,
      );
      if (res) {
        open.trade.outcome = res.outcome;
        open.trade.realizedR = res.outcome === "TP1_HIT" ? RR_TP1 : -1;
        open = null;
      }
    }
    if (open) continue;
    if (i - lastSig < COOLDOWN) continue;

    const packed = framesAtIndex(candles, i, "scalping", htfs);
    if (!packed) continue;

    let sig;
    try {
      sig = generateQuickScalpSignal(
        {
          primary: packed.primary,
          confirmation: packed.confirmation,
          bias: packed.bias,
          daily: packed.daily,
        },
        "XAUUSD",
        "scalping",
      );
    } catch {
      continue;
    }
    if (!sig) continue;

    const entry = applySpread(sig.direction, sig.entry, spread);
    const risk = Math.abs(sig.entry - sig.sl);
    let sl: number;
    let tp1: number;
    if (sig.direction === "BUY") {
      sl = entry - risk;
      tp1 = entry + risk * RR_TP1;
    } else {
      sl = entry + risk;
      tp1 = entry - risk * RR_TP1;
    }

    const trade: Trade = {
      t: candles[i].time,
      dir: sig.direction,
      entry,
      sl,
      tp1,
      outcome: "OPEN",
      realizedR: null,
    };
    trades.push(trade);
    open = { trade, from: i + 1 };
    lastSig = i;
  }
  return trades;
}

function summary(trades: Trade[]) {
  const resolved = trades.filter((t) => t.outcome === "TP1_HIT" || t.outcome === "SL_HIT");
  const wins = resolved.filter((t) => t.outcome === "TP1_HIT").length;
  const losses = resolved.length - wins;
  const winRate = resolved.length ? (wins / resolved.length) * 100 : null;
  const avgR =
    resolved.length && resolved.every((t) => t.realizedR != null)
      ? resolved.reduce((a, t) => a + (t.realizedR as number), 0) / resolved.length
      : null;
  return { signals: trades.length, resolved: resolved.length, wins, losses, winRate, avgR };
}

function main() {
  const days = Number(argValue(process.argv.slice(2), "--days") ?? 45);
  const spread = Number(argValue(process.argv.slice(2), "--spread") ?? 0.25);

  console.log(`Loading ${M5}…`);
  const full = loadHistoricalFile(M5).candles;
  const last = full[full.length - 1].time;
  const windowStartMs = last - days * 24 * 60 * 60 * 1000;
  console.log(`CSV last: ${new Date(last).toISOString()}`);
  console.log(
    `Exact ${days}d window: ${new Date(windowStartMs).toISOString()} → ${new Date(last).toISOString()}`,
  );
  console.log(`spread=${spread} · SL-priority-on-same-bar=YES · cooldown=${COOLDOWN} bars\n`);

  const sliced = filterLastDays(full, days);

  // HTF probe
  const htfsFull = precomputeHtfs(full);
  const htfsSlice = precomputeHtfs(sliced);
  const sliceWin = windowStartIndex(sliced, days);
  const probeSliceI = Math.min(sliced.length - 10, Math.max(sliceWin + 500, 300));
  const probeT = sliced[probeSliceI].time;
  const probeFullI = full.findIndex((c) => c.time === probeT);
  const asOf =
    (probeFullI + 1 < full.length
      ? full[probeFullI + 1].time - full[probeFullI].time
      : 5 * 60 * 1000) + full[probeFullI].time;

  const tail = (bars: Candle[], n: number) =>
    bars.slice(-n).map((b) => `${b.time}:${b.close}`).join("|");
  const dailyMatch =
    tail(onlyFullyClosed(htfsFull.daily, D1_MS, asOf), 30) ===
    tail(onlyFullyClosed(htfsSlice.daily, D1_MS, asOf), 30);
  const h1Match =
    tail(onlyFullyClosed(htfsFull.h1, H1_MS, asOf), 50) ===
    tail(onlyFullyClosed(htfsSlice.h1, H1_MS, asOf), 50);
  const m15Match =
    tail(onlyFullyClosed(htfsFull.m15, M15_MS, asOf), 50) ===
    tail(onlyFullyClosed(htfsSlice.m15, M15_MS, asOf), 50);

  console.log("--- onlyFullyClosed HTF probe (full vs slice aggregates) ---");
  console.log(`probe ${new Date(probeT).toISOString()} asOf=${new Date(asOf).toISOString()}`);
  console.log(`daily/h1/m15 tail match: ${dailyMatch}/${h1Match}/${m15Match}`);

  console.log("\n--- In-memory walk A/B ---");
  const t0 = Date.now();
  const fullTrades = walkQs(full, days, spread);
  console.log(`FULL done ${(Date.now() - t0) / 1000}s`, summary(fullTrades));
  const t1 = Date.now();
  const sliceTrades = walkQs(sliced, days, spread);
  console.log(`SLICE done ${(Date.now() - t1) / 1000}s`, summary(sliceTrades));

  const key = (t: Trade) =>
    `${t.t}|${t.dir}|${t.entry.toFixed(4)}|${t.sl.toFixed(4)}|${t.tp1.toFixed(4)}|${t.outcome}`;
  const setF = new Set(fullTrades.map(key));
  const setS = new Set(sliceTrades.map(key));
  const onlyFull = fullTrades.filter((t) => !setS.has(key(t)));
  const onlySlice = sliceTrades.filter((t) => !setF.has(key(t)));
  const identical = onlyFull.length === 0 && onlySlice.length === 0;

  // Also compare signal timestamps only (ignore resolution if paths differ somehow)
  const sigKey = (t: Trade) => `${t.t}|${t.dir}|${t.entry.toFixed(4)}`;
  const sigOnlyFull = fullTrades.filter(
    (t) => !new Set(sliceTrades.map(sigKey)).has(sigKey(t)),
  );
  const sigOnlySlice = sliceTrades.filter(
    (t) => !new Set(fullTrades.map(sigKey)).has(sigKey(t)),
  );

  console.log("\n=== VERDICT ===");
  console.log(`identical trades (entry+sl+tp1+outcome): ${identical}`);
  console.log(
    `signal identity (t+dir+entry): full-only=${sigOnlyFull.length} slice-only=${sigOnlySlice.length}`,
  );
  if (!identical) {
    console.log("first only-FULL:", onlyFull.slice(0, 3));
    console.log("first only-SLICE:", onlySlice.slice(0, 3));
  }

  const out = {
    days,
    spread,
    slPrioritySameBar: true,
    window: {
      start: new Date(windowStartMs).toISOString(),
      end: new Date(last).toISOString(),
    },
    htfProbe: { dailyMatch, h1Match, m15Match, probeIso: new Date(probeT).toISOString() },
    full: summary(fullTrades),
    slice: summary(sliceTrades),
    identical,
    signalIdentityOk: sigOnlyFull.length === 0 && sigOnlySlice.length === 0,
    onlyFullCount: onlyFull.length,
    onlySliceCount: onlySlice.length,
  };
  writeFileSync("data/_verify_qs_slice_parity.json", JSON.stringify(out, null, 2));
  console.log("Wrote data/_verify_qs_slice_parity.json");
  if (!identical) process.exitCode = 2;
}

main();
