/**
 * Measurement only: fractal-direction-agree WITHOUT SMC quality stack.
 * Window A: 2025-01-30 → 2026-01-30 (same as gate-lift)
 * Window B: 2024-01-30 → 2025-01-30 (non-overlapping robustness)
 *
 * Does not modify fractalLive.ts / live bots.
 *
 *   npx tsx scripts/analyzeFractalAgreeOnly.ts
 */
import { writeFileSync } from "node:fs";
import { loadHistoricalFile } from "../src/backtest/loadData";
import { framesAtIndex, precomputeHtfs } from "../src/backtest/frames";
import { generateSignal } from "../src/strategies/signalEngine";
import { generateFractalSignal } from "../src/strategies/archived/fractalSignal";
import type { Candle } from "../src/types";

const M5 = "data/XAU_5m_data.csv";
const OUT = "data/_fractal_agree_only_analysis.json";
const SPREAD = 0.25;
const WARMUP_MS = 120 * 24 * 60 * 60 * 1000;

type Outcome = "TP1_HIT" | "SL_HIT";
type Bucket = { n: number; wins: number; losses: number; sumR: number };

function empty(): Bucket {
  return { n: 0, wins: 0, losses: 0, sumR: 0 };
}

function add(b: Bucket, r: { outcome: Outcome; realizedR: number }) {
  b.n += 1;
  b.sumR += r.realizedR;
  if (r.outcome === "TP1_HIT") b.wins += 1;
  else b.losses += 1;
}

function summarize(b: Bucket) {
  return {
    n: b.n,
    wins: b.wins,
    losses: b.losses,
    winRate: b.n > 0 ? (b.wins / b.n) * 100 : null,
    avgR: b.n > 0 ? b.sumR / b.n : null,
  };
}

function applySpread(side: "BUY" | "SELL", entry: number, spread: number): number {
  return side === "BUY" ? entry + spread : entry - spread;
}

function resolveIndependent(
  side: "BUY" | "SELL",
  entry: number,
  sl: number,
  tp1: number,
  bars: Candle[],
  from: number,
  spread: number,
): { outcome: Outcome; realizedR: number } | null {
  const e = applySpread(side, entry, spread);
  const risk = Math.abs(entry - sl);
  if (risk <= 0 || !isFinite(risk)) return null;
  const buy = side === "BUY";
  const adjSl = buy ? e - risk : e + risk;
  const adjTp = buy ? e + Math.abs(tp1 - entry) : e - Math.abs(entry - tp1);
  const tp1R = Math.abs(tp1 - entry) / risk;
  for (let i = from; i < bars.length; i++) {
    const b = bars[i];
    const hitSl = buy ? b.low <= adjSl : b.high >= adjSl;
    const hitTp = buy ? b.high >= adjTp : b.low <= adjTp;
    if (hitSl && hitTp) return { outcome: "SL_HIT", realizedR: -1 };
    if (hitSl) return { outcome: "SL_HIT", realizedR: -1 };
    if (hitTp) return { outcome: "TP1_HIT", realizedR: tp1R };
  }
  return null;
}

function qualityOk(
  smc: NonNullable<ReturnType<typeof generateSignal>>,
  side: "BUY" | "SELL",
  minConf: number,
): boolean {
  const d = smc.diagnostics;
  const regime = d.regime ?? "";
  return (
    smc.confidence >= minConf &&
    !!d.htfAligned &&
    !d.conflictingSignals &&
    !d.conflictCapped &&
    (regime === "TREND_UP" || regime === "TREND_DOWN") &&
    ((side === "BUY" && regime === "TREND_UP") ||
      (side === "SELL" && regime === "TREND_DOWN")) &&
    ((side === "BUY" && smc.dailyBias.bias === "BULLISH") ||
      (side === "SELL" && smc.dailyBias.bias === "BEARISH"))
  );
}

function sliceWindow(all: Candle[], startIso: string, endIso: string): {
  candles: Candle[];
  walkStart: number;
  windowStartMs: number;
  windowEndMs: number;
} {
  const windowStartMs = Date.parse(startIso);
  const windowEndMs = Date.parse(endIso);
  const loadFrom = windowStartMs - WARMUP_MS;
  const candles = all.filter((c) => c.time >= loadFrom && c.time <= windowEndMs);
  const walkStart = candles.findIndex((c) => c.time >= windowStartMs);
  if (walkStart < 0 || candles.length < 500) {
    throw new Error(`Window ${startIso}→${endIso}: insufficient bars (${candles.length})`);
  }
  return { candles, walkStart, windowStartMs, windowEndMs };
}

function runWindow(label: string, all: Candle[], startIso: string, endIso: string) {
  const { candles, walkStart, windowStartMs, windowEndMs } = sliceWindow(
    all,
    startIso,
    endIso,
  );
  const htfs = precomputeHtfs(candles);

  const agreeOnly = empty(); // fractal dir === SMC (NO quality stack)
  const qualityGated = empty(); // current TTrades: agree + quality
  const agreeButQualityFail = empty();
  const disagree = empty(); // SMC candidate, fractal disagree / missing
  let smcCandidates = 0;

  console.log(`\n=== ${label} ===`);
  console.log(
    `Window ${new Date(windowStartMs).toISOString()} → ${new Date(windowEndMs).toISOString()}`,
  );
  console.log(`Bars=${candles.length} walkFrom=${walkStart}`);

  const t0 = Date.now();
  for (let i = Math.max(walkStart, 250); i < candles.length; i++) {
    if (candles[i].time > windowEndMs) break;
    if (i % 8000 === 0) {
      process.stdout.write(`\r  ${label} ${i}/${candles.length}  `);
    }

    const frames = framesAtIndex(candles, i, "scalping", htfs);
    if (!frames) continue;

    let smc;
    try {
      smc = generateSignal("XAUUSD", "scalping", {
        primary: frames.primary,
        confirmation: frames.confirmation,
        bias: frames.bias,
        daily: frames.daily,
      });
    } catch {
      continue;
    }
    if (!smc || (smc.side !== "BUY" && smc.side !== "SELL") || !smc.levels) continue;

    const side = smc.side;
    const res = resolveIndependent(
      side,
      smc.levels.entry,
      smc.levels.stopLoss,
      smc.levels.takeProfit1,
      candles,
      i + 1,
      SPREAD,
    );
    if (!res) continue;

    smcCandidates += 1;
    const fr = generateFractalSignal({ candles: frames.primary });
    const agree = !!fr && fr.direction === side;
    const qOk = qualityOk(smc, side, 72);

    if (agree) {
      add(agreeOnly, res);
      if (qOk) add(qualityGated, res);
      else add(agreeButQualityFail, res);
    } else {
      add(disagree, res);
    }
  }
  process.stdout.write("\n");
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s · SMC candidates=${smcCandidates}`);

  const aOnly = summarize(agreeOnly);
  const gated = summarize(qualityGated);
  const qFail = summarize(agreeButQualityFail);
  const disc = summarize(disagree);
  const liftVsDisagree =
    aOnly.winRate != null && disc.winRate != null
      ? aOnly.winRate - disc.winRate
      : null;

  console.log(
    `Fractal-agree-ONLY (no quality): n=${aOnly.n} wr=${aOnly.winRate?.toFixed(1)}% avgR=${aOnly.avgR?.toFixed(3)}`,
  );
  console.log(
    `Current TTrades (agree+quality): n=${gated.n} wr=${gated.winRate?.toFixed(1)}% avgR=${gated.avgR?.toFixed(3)}`,
  );
  console.log(
    `Agree but quality-fail:          n=${qFail.n} wr=${qFail.winRate?.toFixed(1)}% avgR=${qFail.avgR?.toFixed(3)}`,
  );
  console.log(
    `Fractal disagree (baseline):     n=${disc.n} wr=${disc.winRate?.toFixed(1)}% avgR=${disc.avgR?.toFixed(3)}`,
  );
  console.log(
    `Lift agree-only vs disagree: wr ${liftVsDisagree == null ? "n/a" : `${liftVsDisagree >= 0 ? "+" : ""}${liftVsDisagree.toFixed(1)} pts`}`,
  );

  return {
    label,
    window: {
      start: new Date(windowStartMs).toISOString(),
      end: new Date(windowEndMs).toISOString(),
    },
    smcCandidates,
    fractalAgreeOnly: aOnly,
    currentTTradesQualityGated: gated,
    agreeButQualityFail: qFail,
    fractalDisagree: disc,
    liftAgreeOnlyVsDisagreePts: liftVsDisagree,
    gatedVsAgreeOnly: {
      nDelta: (gated.n ?? 0) - (aOnly.n ?? 0),
      wrDelta:
        gated.winRate != null && aOnly.winRate != null
          ? gated.winRate - aOnly.winRate
          : null,
      avgRDelta:
        gated.avgR != null && aOnly.avgR != null ? gated.avgR - aOnly.avgR : null,
    },
  };
}

function main() {
  console.log(`Loading ${M5}…`);
  const all = loadHistoricalFile(M5).candles;
  console.log(
    `Full series: ${new Date(all[0].time).toISOString()} → ${new Date(all[all.length - 1].time).toISOString()} (${all.length} bars)`,
  );

  // End-of-bar alignment to match prior analysis (CSV last bar style timestamps)
  const primary = runWindow(
    "PRIMARY (gate-lift window)",
    all,
    "2025-01-30T23:55:00.000Z",
    "2026-01-30T23:55:00.000Z",
  );
  const robust = runWindow(
    "ROBUSTNESS (non-overlapping prior year)",
    all,
    "2024-01-30T23:55:00.000Z",
    "2025-01-30T23:55:00.000Z",
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    tempered: false,
    liveModuleChanged: false,
    spread: SPREAD,
    method:
      "SMC candidates with BUY/SELL+levels; fractal-agree = generateFractalSignal.direction === smc.side; quality stack = conf≥72+HTF+no conflict+TREND+daily (mirrors fractalLive). Outcomes on SMC native TP1, spread 0.25, SL same-bar priority. Per-bar independent resolution.",
    primary,
    robustness: robust,
  };

  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${OUT}`);

  console.log("\n======== SUMMARY ========");
  console.log("PRIMARY agree-only vs current gated:");
  console.log(
    `  agree-only: ${primary.fractalAgreeOnly.n} / ${primary.fractalAgreeOnly.winRate?.toFixed(1)}% / ${primary.fractalAgreeOnly.avgR?.toFixed(3)}R`,
  );
  console.log(
    `  gated:      ${primary.currentTTradesQualityGated.n} / ${primary.currentTTradesQualityGated.winRate?.toFixed(1)}% / ${primary.currentTTradesQualityGated.avgR?.toFixed(3)}R`,
  );
  console.log("ROBUSTNESS agree-only:");
  console.log(
    `  agree-only: ${robust.fractalAgreeOnly.n} / ${robust.fractalAgreeOnly.winRate?.toFixed(1)}% / ${robust.fractalAgreeOnly.avgR?.toFixed(3)}R`,
  );
  console.log(
    `  lift vs disagree: ${robust.liftAgreeOnlyVsDisagreePts?.toFixed(1)} pts`,
  );
}

main();
