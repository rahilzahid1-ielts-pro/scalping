/**
 * Measurement-only TrendBurst backtest (no live wiring).
 *
 *   npx tsx scripts/backtestTrendBurst.ts
 *   npx tsx scripts/backtestTrendBurst.ts --file=C:\path\XAUUSD_M5.json
 *
 * Pipeline: XAUUSD_M5.json, 365d, spread 0.25.
 * Entry = trigger-bar close ± spread. Resolution walks subsequent M5 bars
 * until ±$3.00; same-bar SL-priority ties.
 * Variants A/B/C evaluated independently (overlapping allowed).
 */
import { existsSync, writeFileSync } from "node:fs";
import { loadHistoricalFile, windowStartIndex } from "../src/backtest/loadData";
import { framesAtIndex, precomputeHtfs } from "../src/backtest/frames";
import { newTrendTracker } from "../src/utils/trendConfirm";
import {
  TREND_BURST_DISTANCE,
  applyTrendBurstSpread,
  generateTrendBurstSignal,
  type TrendBurstVariant,
} from "../src/strategies/trendBurstEngine";
import type { AssetId, Candle } from "../src/types";

const DEFAULT_FILE = "C:/scalping/data/XAUUSD_M5.json";
const OUT = "data/_trend_burst_backtest.json";
const SPREAD = 0.25;
const DAYS = 365;
const ASSET: AssetId = "XAUUSD";
const LOW_N = 50;
const MODE = "scalping" as const;

type TradeResult = {
  barsToResolve: number;
  outcome: "TP" | "SL";
  realizedR: number;
};

type VariantStats = {
  id: string;
  label: string;
  variant: TrendBurstVariant;
  signalsFired: number;
  nResolved: number;
  tpFirst: number;
  slFirst: number;
  tpFirstWinPct: number | null;
  avgBarsToResolution: number | null;
  avgR: number | null;
  signalsPerYear: number;
  lowConfidence: boolean;
  unresolved: number;
};

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

/**
 * Resolve from the bar AFTER entry (close fill has no look-ahead on the
 * trigger bar's own high/low path). That next bar is counted as bar 1.
 * Same-bar SL+TP → SL wins.
 */
function resolveFixedRace(
  candles: Candle[],
  entryIndex: number,
  side: "BUY" | "SELL",
  entry: number,
): TradeResult | null {
  const target =
    side === "BUY" ? entry + TREND_BURST_DISTANCE : entry - TREND_BURST_DISTANCE;
  const adverse =
    side === "BUY" ? entry - TREND_BURST_DISTANCE : entry + TREND_BURST_DISTANCE;

  for (let i = entryIndex + 1; i < candles.length; i++) {
    const bar = candles[i];
    const hitSl = side === "BUY" ? bar.low <= adverse : bar.high >= adverse;
    const hitTp = side === "BUY" ? bar.high >= target : bar.low <= target;
    const bars = i - entryIndex; // entryIndex+1 → 1

    if (hitSl && hitTp) {
      return { barsToResolve: bars, outcome: "SL", realizedR: -1 };
    }
    if (hitSl) {
      return { barsToResolve: bars, outcome: "SL", realizedR: -1 };
    }
    if (hitTp) {
      return { barsToResolve: bars, outcome: "TP", realizedR: 1 };
    }
  }
  return null;
}

function runVariant(
  variant: TrendBurstVariant,
  label: string,
  candles: Candle[],
  windowStartIdx: number,
): VariantStats {
  const htfs = precomputeHtfs(candles);
  const tracker = newTrendTracker();
  const results: TradeResult[] = [];
  let fired = 0;
  let unresolved = 0;

  for (let i = windowStartIdx; i < candles.length; i++) {
    if (i === windowStartIdx || i === candles.length - 1 || i % 10000 === 0) {
      process.stdout.write(
        `\r  ${label} ${i}/${candles.length} (${((i / candles.length) * 100).toFixed(0)}%)   `,
      );
    }

    const frames = framesAtIndex(candles, i, MODE, htfs);
    if (!frames) continue;

    const probe = candles[i].close;
    const raw = generateTrendBurstSignal(frames, tracker, probe, variant, {
      assetId: ASSET,
      mode: MODE,
      barTime: candles[i].time,
    });
    if (!raw) continue;

    fired += 1;
    const entry = applyTrendBurstSpread(raw.direction, candles[i].close, SPREAD);
    const resolved = resolveFixedRace(candles, i, raw.direction, entry);
    if (!resolved) {
      unresolved += 1;
      continue;
    }
    results.push(resolved);
  }
  process.stdout.write("\n");

  const tpFirst = results.filter((r) => r.outcome === "TP").length;
  const slFirst = results.filter((r) => r.outcome === "SL").length;
  const n = results.length;
  const avgBars =
    n > 0
      ? results.reduce((s, r) => s + r.barsToResolve, 0) / n
      : null;
  const avgR =
    n > 0 ? results.reduce((s, r) => s + r.realizedR, 0) / n : null;

  return {
    id: variant,
    label,
    variant,
    signalsFired: fired,
    nResolved: n,
    tpFirst,
    slFirst,
    tpFirstWinPct: n > 0 ? (tpFirst / n) * 100 : null,
    avgBarsToResolution: avgBars,
    avgR,
    signalsPerYear: fired,
    lowConfidence: n < LOW_N,
    unresolved,
  };
}

function main() {
  const file = argValue(process.argv.slice(2), "--file") ?? DEFAULT_FILE;
  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  console.log(`Loading ${file}…`);
  const loaded = loadHistoricalFile(file);
  const candles = loaded.candles;
  const winStart = windowStartIndex(candles, DAYS);

  console.log(`
TrendBurst measurement (isolated — no live wiring)
──────────────────────────────────────────────────
File       : ${file}
Range      : ${loaded.quality.firstIso} → ${loaded.quality.lastIso}
Bars       : ${loaded.quality.bars}
Window     : last ${DAYS}d (start idx ${winStart})
Spread     : ${SPREAD} (BUY +spread / SELL −spread on close fill)
Distance   : ±$${TREND_BURST_DISTANCE.toFixed(2)} (NOT $30)
A/B        : fire on trendConfirm newEvent (gated + SMC agree)
C          : armed window + shallow pullback-resume, one entry per run
Resolve    : walk from bar AFTER entry; same-bar SL-priority
`);

  const variants: { variant: TrendBurstVariant; label: string }[] = [
    { variant: "solo", label: "A) TrendBurst-solo" },
    { variant: "gated", label: "B) TrendBurst-gated" },
    { variant: "pullback", label: "C) TrendBurst-pullback" },
  ];

  const results: VariantStats[] = [];
  for (const v of variants) {
    console.log(`\n======== ${v.label} ========`);
    results.push(runVariant(v.variant, v.label, candles, winStart));
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    method:
      "TrendBurst isolated walk-forward. Entry = trigger close ± spread. Resolve subsequent M5 bars to ±$3.00; SL wins same-bar ties. A solo = newEvent; B gated = newEvent + SMC agree; C pullback = armed + pullback-resume (one per run).",
    file,
    days: DAYS,
    spread: SPREAD,
    fixedDistance: TREND_BURST_DISTANCE,
    windowStartIdx: winStart,
    windowStartIso: new Date(candles[winStart]?.time ?? 0).toISOString(),
    lowConfidenceThreshold: LOW_N,
    results,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${OUT}`);

  console.log("\n======== TRENDBURST A/B/C ========");
  console.log(
    "Variant                | Fired | n res | TP-first% | Avg bars | Avg R   | /year | Flag",
  );
  console.log(
    "-----------------------|-------|-------|-----------|----------|---------|-------|------",
  );
  for (const r of results) {
    const wr =
      r.tpFirstWinPct == null ? "n/a" : `${r.tpFirstWinPct.toFixed(1)}%`;
    const bars =
      r.avgBarsToResolution == null
        ? "n/a"
        : r.avgBarsToResolution.toFixed(2);
    const ar =
      r.avgR == null ? "n/a" : `${r.avgR >= 0 ? "+" : ""}${r.avgR.toFixed(3)}`;
    const flag = r.lowConfidence ? "LOW CONFIDENCE — small sample" : "";
    console.log(
      `${r.label.padEnd(22)} | ${String(r.signalsFired).padStart(5)} | ${String(r.nResolved).padStart(5)} | ${wr.padStart(9)} | ${bars.padStart(8)} | ${ar.padStart(7)} | ${String(r.signalsPerYear).padStart(5)} | ${flag}`,
    );
  }
}

main();
