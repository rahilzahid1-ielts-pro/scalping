/**
 * Measurement-only Strong Candle backtest (no live wiring approval).
 *
 *   npx tsx scripts/backtestStrongCandle.ts
 *   npx tsx scripts/backtestStrongCandle.ts --file=C:\path\XAUUSD_M5.json
 *
 * Pipeline: XAUUSD_M5.json, 365d, spread 0.25.
 * Engine AS BUILT: body≥85% range, each wick≤8%, H1 same-color gate.
 * Entry = trigger-bar close ± spread. Resolution walks subsequent M5 bars
 * until ±$3.00; same-bar SL-priority ties (same as TrendBurst).
 *
 * Live engine uses lastClosedBar (skips a forming tip). framesAtIndex only
 * returns fully-closed HTF/primary tips, so we append a synthetic forming
 * stub so generateStrongCandleSignal sees the just-closed M5/H1 as live does.
 */
import { existsSync, writeFileSync } from "node:fs";
import { loadHistoricalFile, windowStartIndex } from "../src/backtest/loadData";
import { framesAtIndex, precomputeHtfs } from "../src/backtest/frames";
import {
  STRONG_CANDLE_TP_DISTANCE,
  STRONG_CANDLE_SL_DISTANCE,
  candleColor,
  diagnoseStrongCandle,
  generateStrongCandleSignal,
  isStrongCandle,
  type StrongCandleFrames,
} from "../src/strategies/strongCandleEngine";
import type { AssetId, Candle } from "../src/types";

const DEFAULT_FILE = "C:/scalping/data/XAUUSD_M5.json";
const OUT = "data/_strong_candle_backtest.json";
const SPREAD = 0.25;
const DAYS = 365;
const ASSET: AssetId = "XAUUSD";
const LOW_N = 50;
const MODE = "scalping" as const;
const DISTANCE = STRONG_CANDLE_TP_DISTANCE;

type TradeResult = {
  barsToResolve: number;
  outcome: "TP" | "SL";
  realizedR: number;
};

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

/** Mimic live feed tip: last bar is forming, so lastClosedBar → previous. */
function withFormingStub(frames: StrongCandleFrames): StrongCandleFrames {
  const stub = (c: Candle): Candle => ({
    time: c.time + 1,
    open: c.close,
    high: c.close,
    low: c.close,
    close: c.close,
    volume: 0,
  });
  const primary = frames.primary ?? [];
  const bias = frames.bias ?? [];
  return {
    ...frames,
    primary: primary.length ? [...primary, stub(primary[primary.length - 1])] : primary,
    bias: bias.length ? [...bias, stub(bias[bias.length - 1])] : bias,
  };
}

function applySpread(side: "BUY" | "SELL", close: number, spread: number): number {
  if (spread <= 0) return close;
  return side === "BUY" ? close + spread : close - spread;
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
  const target = side === "BUY" ? entry + DISTANCE : entry - DISTANCE;
  const adverse = side === "BUY" ? entry - DISTANCE : entry + DISTANCE;

  for (let i = entryIndex + 1; i < candles.length; i++) {
    const bar = candles[i];
    const hitSl = side === "BUY" ? bar.low <= adverse : bar.high >= adverse;
    const hitTp = side === "BUY" ? bar.high >= target : bar.low <= target;
    const bars = i - entryIndex;

    if (hitSl && hitTp) {
      return { barsToResolve: bars, outcome: "SL", realizedR: -1 };
    }
    if (hitSl) {
      return { barsToResolve: bars, outcome: "SL", realizedR: -1 };
    }
    if (hitTp) {
      return {
        barsToResolve: bars,
        outcome: "TP",
        realizedR: DISTANCE / STRONG_CANDLE_SL_DISTANCE,
      };
    }
  }
  return null;
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
  const htfs = precomputeHtfs(candles);

  console.log(`
Strong Candle measurement (isolated — NOT approved for live wiring)
──────────────────────────────────────────────────────────────────
File       : ${file}
Range      : ${loaded.quality.firstIso} → ${loaded.quality.lastIso}
Bars       : ${loaded.quality.bars}
Window     : last ${DAYS}d (start idx ${winStart})
Spread     : ${SPREAD} (BUY +spread / SELL −spread on close fill)
Distance   : TP ±$${DISTANCE.toFixed(2)} / SL ±$${STRONG_CANDLE_SL_DISTANCE.toFixed(2)} (NOT $30)
Rules      : body≥85% range · each wick≤8% · H1 same color (engine as built)
Resolve    : walk from bar AFTER entry; same-bar SL-priority (TrendBurst parity)
`);

  const results: TradeResult[] = [];
  let fired = 0;
  let unresolved = 0;
  let strongM5 = 0;
  let rejectedH1Mismatch = 0;
  let rejectedH1Doji = 0;
  let rejectedOther = 0;
  let lastFiredBarTime = -1;

  for (let i = winStart; i < candles.length; i++) {
    if (i === winStart || i === candles.length - 1 || i % 10000 === 0) {
      process.stdout.write(
        `\r  StrongCandle ${i}/${candles.length} (${((i / candles.length) * 100).toFixed(0)}%)   `,
      );
    }

    const frames = framesAtIndex(candles, i, MODE, htfs);
    if (!frames) continue;

    const liveLike = withFormingStub(frames);
    const m5 = candles[i];

    // Funnel accounting on the just-closed M5 (same bar the engine would see).
    if (isStrongCandle(m5) && candleColor(m5) !== "DOJI") {
      strongM5 += 1;
      const diag = diagnoseStrongCandle(liveLike);
      if (!diag.pass) {
        if (diag.waitReason.startsWith("Color mismatch")) {
          rejectedH1Mismatch += 1;
        } else if (diag.waitReason.includes("H1 last closed is doji")) {
          rejectedH1Doji += 1;
        } else {
          rejectedOther += 1;
        }
      }
    }

    const sig = generateStrongCandleSignal(ASSET, liveLike);
    if (!sig) continue;
    // One signal per M5 bar (matches bot m5BarTime dedupe).
    if (sig.m5BarTime === lastFiredBarTime) continue;
    if (sig.m5BarTime !== m5.time) continue; // safety: must be this closed bar

    lastFiredBarTime = sig.m5BarTime;
    fired += 1;

    const entry = applySpread(sig.direction, m5.close, SPREAD);
    const resolved = resolveFixedRace(candles, i, sig.direction, entry);
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
    n > 0 ? results.reduce((s, r) => s + r.barsToResolve, 0) / n : null;
  const avgR = n > 0 ? results.reduce((s, r) => s + r.realizedR, 0) / n : null;
  const h1RejectPct =
    strongM5 > 0 ? (rejectedH1Mismatch / strongM5) * 100 : null;

  const summary = {
    id: "strong_candle",
    label: "Strong Candle (as built)",
    signalsFired: fired,
    nResolved: n,
    tpFirst,
    slFirst,
    tpFirstWinPct: n > 0 ? (tpFirst / n) * 100 : null,
    avgBarsToResolution: avgBars,
    avgR,
    signalsPerYear: fired,
    unresolved,
    lowConfidence: n < LOW_N,
    funnel: {
      strongM5Candles: strongM5,
      rejectedH1Mismatch,
      rejectedH1Doji,
      rejectedOtherAfterStrongM5: rejectedOther,
      pctStrongM5RejectedH1Mismatch: h1RejectPct,
    },
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    method:
      "Strong Candle isolated walk-forward AS BUILT. Live-like forming stub so lastClosedBar matches live tip. Entry = trigger close ± spread. Resolve subsequent M5 bars to ±$3.00; SL wins same-bar ties. H1 mismatch % = color-mismatch rejects / strong-M5 candles.",
    file,
    days: DAYS,
    spread: SPREAD,
    tpDistance: DISTANCE,
    slDistance: STRONG_CANDLE_SL_DISTANCE,
    windowStartIdx: winStart,
    windowStartIso: new Date(candles[winStart]?.time ?? 0).toISOString(),
    lowConfidenceThreshold: LOW_N,
    result: summary,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${OUT}`);

  console.log("\n======== STRONG CANDLE ========");
  console.log(
    "Module                      | Fired | n res | TP-first% | Avg bars | Avg R   | /year | Flag",
  );
  console.log(
    "----------------------------|-------|-------|-----------|----------|---------|-------|------",
  );
  const wr =
    summary.tpFirstWinPct == null
      ? "n/a"
      : `${summary.tpFirstWinPct.toFixed(1)}%`;
  const bars =
    summary.avgBarsToResolution == null
      ? "n/a"
      : summary.avgBarsToResolution.toFixed(2);
  const ar =
    summary.avgR == null
      ? "n/a"
      : `${summary.avgR >= 0 ? "+" : ""}${summary.avgR.toFixed(3)}`;
  const flag = summary.lowConfidence ? "LOW CONFIDENCE — small sample" : "";
  console.log(
    `${summary.label.padEnd(27)} | ${String(summary.signalsFired).padStart(5)} | ${String(summary.nResolved).padStart(5)} | ${wr.padStart(9)} | ${bars.padStart(8)} | ${ar.padStart(7)} | ${String(summary.signalsPerYear).padStart(5)} | ${flag}`,
  );
  console.log("\nFunnel (strong M5 → H1 gate)");
  console.log(`  Strong M5 candles          : ${strongM5}`);
  console.log(
    `  Rejected H1 color mismatch : ${rejectedH1Mismatch}${
      h1RejectPct == null ? "" : ` (${h1RejectPct.toFixed(1)}% of strong M5)`
    }`,
  );
  console.log(`  Rejected H1 doji           : ${rejectedH1Doji}`);
  console.log(`  Rejected other (after M5)  : ${rejectedOther}`);
  console.log(`  Unresolved at EOF          : ${unresolved}`);
}

main();
