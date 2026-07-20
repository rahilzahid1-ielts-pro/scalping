/**
 * Gate lift analysis — Group A (module gate pass) vs Group B (SMC yes, gate no).
 * Same 365d CSV window. Resolves BOTH groups on MAIN SMC levels (not remapped TP1)
 * so the comparison isolates selection, not TP geometry.
 *
 * Does not modify strategy engines.
 *
 *   npx tsx scripts/analyzeGateLift.ts [--days=365] [--spread=0.25]
 */
import { writeFileSync } from "node:fs";
import {
  filterLastDays,
  loadHistoricalFile,
  windowStartIndex,
} from "../src/backtest/loadData";
import {
  framesAtIndex,
  isClosedFifteenEnd,
  precomputeHtfs,
} from "../src/backtest/frames";
import { generateSignal } from "../src/strategies/signalEngine";
import { generateCipherBSignal } from "../src/strategies/archived/cipherBSignal";
import { generateFractalSignal } from "../src/strategies/archived/fractalSignal";
import { generateProSignal } from "../src/strategies/proEngine";
import { generateCipherBLiveSignal } from "../src/strategies/cipherBLive";
import { generateFractalLiveSignal } from "../src/strategies/fractalLive";
import type { Candle } from "../src/types";

const M5 = "data/XAU_5m_data.csv";
const OUT = "data/_gate_lift_analysis.json";

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

type Outcome = "TP1_HIT" | "SL_HIT";

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

type Bucket = {
  n: number;
  wins: number;
  losses: number;
  sumR: number;
};

function emptyBucket(): Bucket {
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

function main() {
  const days = Number(argValue(process.argv.slice(2), "--days") ?? 365);
  const spread = Number(argValue(process.argv.slice(2), "--spread") ?? 0.25);

  console.log(`Loading ${M5}…`);
  const loaded = loadHistoricalFile(M5);
  const candles = filterLastDays(loaded.candles, days);
  const start = windowStartIndex(candles, days);
  const last = candles[candles.length - 1].time;
  const windowStartMs = last - days * 24 * 60 * 60 * 1000;
  const htfs = precomputeHtfs(candles);

  console.log(
    `Window: ${new Date(windowStartMs).toISOString()} → ${new Date(last).toISOString()}`,
  );
  console.log(
    `Bars in slice: ${candles.length} · walk from idx ${start} · spread=${spread}`,
  );
  console.log(
    `Method: every main SMC BUY/SELL+levels candidate; resolve on SMC native TP1; A=module pass B=module fail\n`,
  );

  const modules = {
    cipher_b: { A: emptyBucket(), B: emptyBucket(), smcCandidates: 0 },
    fractal: { A: emptyBucket(), B: emptyBucket(), smcCandidates: 0 },
    pro: { A: emptyBucket(), B: emptyBucket(), smcCandidates: 0 },
  };

  // Extra detail: for Cipher/Fractal, split B into "indicator disagree" vs "SMC quality fail after indicator agree"
  const cipherBDetail = {
    indicatorDisagree: emptyBucket(),
    qualityFail: emptyBucket(),
  };
  const fractalDetail = {
    indicatorDisagree: emptyBucket(),
    qualityFail: emptyBucket(),
  };

  const t0 = Date.now();
  for (let i = Math.max(start, 250); i < candles.length; i++) {
    if (i % 5000 === 0) {
      process.stdout.write(
        `\r  ${i}/${candles.length} (${(((i - start) / Math.max(1, candles.length - start)) * 100).toFixed(0)}%)  `,
      );
    }

    // --- Scalping candidates (Cipher + Fractal share same SMC base) ---
    const scalpFrames = framesAtIndex(candles, i, "scalping", htfs);
    if (scalpFrames) {
      let smc;
      try {
        smc = generateSignal("XAUUSD", "scalping", {
          primary: scalpFrames.primary,
          confirmation: scalpFrames.confirmation,
          bias: scalpFrames.bias,
          daily: scalpFrames.daily,
        });
      } catch {
        smc = null;
      }

      if (smc && (smc.side === "BUY" || smc.side === "SELL") && smc.levels) {
        const side = smc.side;
        const entry = smc.levels.entry;
        const sl = smc.levels.stopLoss;
        const tp1 = smc.levels.takeProfit1;
        const res = resolveIndependent(side, entry, sl, tp1, candles, i + 1, spread);
        if (res) {
          // Cipher
          modules.cipher_b.smcCandidates += 1;
          const cipherInd = generateCipherBSignal({ candles: scalpFrames.primary });
          const cipherLive = generateCipherBLiveSignal({
            ...scalpFrames,
            assetId: "XAUUSD",
            mode: "scalping",
          });
          if (cipherLive) {
            add(modules.cipher_b.A, res);
          } else {
            add(modules.cipher_b.B, res);
            if (!cipherInd || cipherInd.direction !== side) {
              add(cipherBDetail.indicatorDisagree, res);
            } else {
              add(cipherBDetail.qualityFail, res);
            }
          }

          // Fractal
          modules.fractal.smcCandidates += 1;
          const frInd = generateFractalSignal({ candles: scalpFrames.primary });
          const frLive = generateFractalLiveSignal({
            ...scalpFrames,
            assetId: "XAUUSD",
            mode: "scalping",
          });
          if (frLive) {
            add(modules.fractal.A, res);
          } else {
            add(modules.fractal.B, res);
            if (!frInd || frInd.direction !== side) {
              add(fractalDetail.indicatorDisagree, res);
            } else {
              add(fractalDetail.qualityFail, res);
            }
          }
        }
      }
    }

    // --- Pro: intraday frames, only closed M15 ends ---
    if (isClosedFifteenEnd(candles, i)) {
      const idFrames = framesAtIndex(candles, i, "intraday", htfs);
      if (idFrames) {
        let smc;
        try {
          smc = generateSignal("XAUUSD", "intraday", {
            primary: idFrames.primary,
            confirmation: idFrames.confirmation,
            bias: idFrames.bias,
            daily: idFrames.daily,
          });
        } catch {
          smc = null;
        }
        if (smc && (smc.side === "BUY" || smc.side === "SELL") && smc.levels) {
          modules.pro.smcCandidates += 1;
          const side = smc.side;
          const entry = smc.levels.entry;
          const sl = smc.levels.stopLoss;
          const tp1 = smc.levels.takeProfit1;
          const res = resolveIndependent(side, entry, sl, tp1, candles, i + 1, spread);
          if (res) {
            const pro = generateProSignal(
              "XAUUSD",
              {
                primary: idFrames.primary,
                confirmation: idFrames.confirmation,
                bias: idFrames.bias,
                daily: idFrames.daily,
              },
              "intraday",
            );
            if (pro) add(modules.pro.A, res);
            else add(modules.pro.B, res);
          }
        }
      }
    }
  }
  process.stdout.write("\n");
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  function lift(name: string, A: Bucket, B: Bucket, smcCandidates: number) {
    const a = summarize(A);
    const b = summarize(B);
    const wrDelta =
      a.winRate != null && b.winRate != null ? a.winRate - b.winRate : null;
    const avgDelta =
      a.avgR != null && b.avgR != null ? a.avgR - b.avgR : null;
    console.log(`=== ${name} ===`);
    console.log(`SMC candidates (actionable): ${smcCandidates}`);
    console.log(
      `Group A (gate PASS): n=${a.n}  wr=${a.winRate?.toFixed(1)}%  avgR=${a.avgR?.toFixed(3)}`,
    );
    console.log(
      `Group B (gate FAIL): n=${b.n}  wr=${b.winRate?.toFixed(1)}%  avgR=${b.avgR?.toFixed(3)}`,
    );
    console.log(
      `Lift A−B: wr ${wrDelta == null ? "n/a" : (wrDelta >= 0 ? "+" : "") + wrDelta.toFixed(1) + " pts"}  avgR ${avgDelta == null ? "n/a" : (avgDelta >= 0 ? "+" : "") + avgDelta.toFixed(3)}`,
    );
    console.log("");
    return { A: a, B: b, wrDelta, avgDelta, smcCandidates };
  }

  const results = {
    cipher_b: lift(
      "Cipher B (WaveTrend agree + SMC quality)",
      modules.cipher_b.A,
      modules.cipher_b.B,
      modules.cipher_b.smcCandidates,
    ),
    fractal: lift(
      "TTrades Fractal (fractal agree + SMC quality)",
      modules.fractal.A,
      modules.fractal.B,
      modules.fractal.smcCandidates,
    ),
    pro: lift(
      "Pro (strict SMC quality only)",
      modules.pro.A,
      modules.pro.B,
      modules.pro.smcCandidates,
    ),
  };

  console.log("--- Cipher B reject split (subset of B) ---");
  console.log("indicator disagree:", summarize(cipherBDetail.indicatorDisagree));
  console.log("indicator agree but quality fail:", summarize(cipherBDetail.qualityFail));
  console.log("\n--- Fractal reject split (subset of B) ---");
  console.log("indicator disagree:", summarize(fractalDetail.indicatorDisagree));
  console.log("indicator agree but quality fail:", summarize(fractalDetail.qualityFail));

  const payload = {
    generatedAt: new Date().toISOString(),
    tempered: false,
    window: {
      start: new Date(windowStartMs).toISOString(),
      end: new Date(last).toISOString(),
      days,
      spread,
    },
    method:
      "Candidates = generateSignal BUY/SELL+levels. Outcome = SMC native TP1 vs SL (spread 0.25, SL same-bar priority). Group A = module live gate pass; Group B = fail. Independent per-bar resolution (no position lock). Autocorrelated bars → n is large; compare A vs B lift, not absolute n.",
    blitzMechanism: {
      usesMainGenerateSignal: true,
      path: "generateQuickScalpSignal → generateSignal(assetId, mode, frames) then conf/HTF/trend/daily gates + TP1 remap 0.85R",
      independentEngine: false,
      file: "src/strategies/quickScalpEngine.ts lines 79–94",
    },
    results,
    rejectSplits: {
      cipher_b: {
        indicatorDisagree: summarize(cipherBDetail.indicatorDisagree),
        qualityFail: summarize(cipherBDetail.qualityFail),
      },
      fractal: {
        indicatorDisagree: summarize(fractalDetail.indicatorDisagree),
        qualityFail: summarize(fractalDetail.qualityFail),
      },
    },
  };

  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${OUT}`);
}

main();
