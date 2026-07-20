/**
 * Scan today's session (UTC) for QS / Pro / Fractal live signals on live candles.
 *   npx tsx scripts/scanTodaySetups.ts
 */
import { fetchMultiTimeframe } from "../src/services/marketData";
import { generateSignal } from "../src/strategies/signalEngine";
import { generateQuickScalpSignal } from "../src/strategies/quickScalpEngine";
import { generateProSignal } from "../src/strategies/proEngine";
import { generateFractalLiveSignal } from "../src/strategies/fractalLive";
import { framesAtIndex, isClosedFifteenEnd, precomputeHtfs } from "../src/backtest/frames";
import type { Candle } from "../src/types";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";

function dayStartUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function countDb() {
  if (!existsSync("data/signals.db")) {
    console.log("DB: no data/signals.db");
    return;
  }
  const db = new Database("data/signals.db", { readonly: true });
  const start = dayStartUtc(Date.now());
  for (const t of ["quick_scalp_signals", "pro_signals", "strategy_signals", "signals"] as const) {
    try {
      const cols = (
        db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]
      ).map((c) => c.name);
      const tsCol = cols.includes("timestamp")
        ? "timestamp"
        : cols.includes("time")
          ? "time"
          : null;
      if (!tsCol) {
        console.log(`DB ${t}: no time col`);
        continue;
      }
      const nToday = (
        db
          .prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE ${tsCol} >= ?`)
          .get(start) as { c: number }
      ).c;
      const nAll = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
      console.log(`DB ${t}: today=${nToday} all=${nAll}`);
    } catch (e) {
      console.log(`DB ${t}:`, e instanceof Error ? e.message : e);
    }
  }
  db.close();
}

async function main() {
  console.log("=== Locked rows (local DB) ===");
  countDb();

  console.log("\n=== Live candle scan (today UTC) ===");
  let scalp;
  try {
    scalp = await fetchMultiTimeframe("XAUUSD", "scalping", undefined, {
      rebaseToLive: false,
    });
  } catch (e) {
    console.log("Market fetch FAILED:", e instanceof Error ? e.message : e);
    console.log(
      "Agar live candles nahi aati → desk WAIT dikha sakta hai / workers fire nahi kar sakte.",
    );
    return;
  }

  const m5 = scalp.primary;
  const last = m5[m5.length - 1];
  const today0 = dayStartUtc(last.time);
  const startI = m5.findIndex((c) => c.time >= today0);
  console.log(
    `M5 bars today: ${m5.length - Math.max(0, startI)} · last=${new Date(last.time).toISOString()} · price≈${last.close}`,
  );

  const smcNow = generateSignal("XAUUSD", "scalping", scalp);
  console.log(
    `NOW SMC: side=${smcNow.side} conf=${smcNow.confidence}% regime=${smcNow.diagnostics.regime} daily=${smcNow.dailyBias.bias}`,
  );
  console.log(
    `NOW modules: QS=${generateQuickScalpSignal(scalp) ? "FIRE" : "null"}  Fractal=${generateFractalLiveSignal({ ...scalp, assetId: "XAUUSD", mode: "scalping" }) ? "FIRE" : "null"}`,
  );

  // Walk today's M5 with HTF from full pack approximation:
  // Use only the fetched series (already limited lookback from API).
  const htfs = precomputeHtfs(m5);
  let qsHits = 0;
  let frHits = 0;
  let smcBuySell = 0;
  let smcWait = 0;
  const qsTimes: string[] = [];
  const frTimes: string[] = [];

  const from = Math.max(startI < 0 ? 0 : startI, 250);
  for (let i = from; i < m5.length; i++) {
    const frames = framesAtIndex(m5, i, "scalping", htfs);
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
    if (smc.side === "BUY" || smc.side === "SELL") smcBuySell += 1;
    else smcWait += 1;

    const qs = generateQuickScalpSignal(
      {
        primary: frames.primary,
        confirmation: frames.confirmation,
        bias: frames.bias,
        daily: frames.daily,
      },
      "XAUUSD",
      "scalping",
    );
    if (qs) {
      qsHits += 1;
      if (qsTimes.length < 8) qsTimes.push(`${new Date(m5[i].time).toISOString()} ${qs.direction}`);
    }

    const fr = generateFractalLiveSignal({
      primary: frames.primary,
      confirmation: frames.confirmation,
      bias: frames.bias,
      daily: frames.daily,
      assetId: "XAUUSD",
      mode: "scalping",
    });
    if (fr) {
      frHits += 1;
      if (frTimes.length < 8) frTimes.push(`${new Date(m5[i].time).toISOString()} ${fr.direction}`);
    }
  }

  // Pro on M15 ends today
  const id = await fetchMultiTimeframe("XAUUSD", "intraday", undefined, {
    rebaseToLive: false,
  });
  const htfsId = precomputeHtfs(id.primary.length ? id.primary : m5);
  const base = id.primary.length > 400 ? id.primary : m5;
  const ht = id.primary.length > 400 ? precomputeHtfs(base) : htfsId;
  let proHits = 0;
  const proTimes: string[] = [];
  const day0 = dayStartUtc(base[base.length - 1].time);
  const bStart = Math.max(
    base.findIndex((c) => c.time >= day0),
    250,
  );
  for (let i = bStart < 0 ? 250 : bStart; i < base.length; i++) {
    if (!isClosedFifteenEnd(base, i)) continue;
    const frames = framesAtIndex(base, i, "intraday", ht);
    if (!frames) continue;
    const pro = generateProSignal(
      "XAUUSD",
      {
        primary: frames.primary,
        confirmation: frames.confirmation,
        bias: frames.bias,
        daily: frames.daily,
      },
      "intraday",
    );
    if (pro) {
      proHits += 1;
      if (proTimes.length < 8)
        proTimes.push(`${new Date(base[i].time).toISOString()} ${pro.direction}`);
    }
  }

  console.log("\n=== Today bar-level hits (engine would fire; not DB locks) ===");
  console.log(`SMC BUY/SELL bars: ${smcBuySell} · WAIT/flat bars: ${smcWait}`);
  console.log(`Quick Scalp hit bars: ${qsHits}`, qsTimes);
  console.log(`Fractal lean hit bars: ${frHits}`, frTimes);
  console.log(`Pro hit bars (M15 ends): ${proHits}`, proTimes);
  console.log(
    "\nNote: hit bars ≠ locked trades. Workers + cooldown needed to write DB / show card.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
