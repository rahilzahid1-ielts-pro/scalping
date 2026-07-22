/**
 * Intra30 Step-2 backtest — same live formula:
 *   pehli strong M5 (body≥85%, wick≤8%) → next bar open
 *   TP1 $3 / TP2 $6 / SL $3 · after TP1, weak candle → TP1_HIT
 *   Multi-open OK (dedupe strongBarTime)
 *
 *   npx tsx scripts/backtestIntra30.ts
 *   npx tsx scripts/backtestIntra30.ts --file=C:\path\XAUUSD_M5.json
 *
 * Writes data/intra30-backtest.db + prints snapshot numbers for
 * src/intra30/backtestSnapshot.ts (Railway badge fallback).
 */
import { existsSync, writeFileSync } from "node:fs";
import { loadHistoricalFile, windowStartIndex } from "../src/backtest/loadData";
import {
  generateIntra30Signal,
  isWeakCandle,
  INTRA30_SL_DISTANCE,
  INTRA30_TP_DISTANCE,
  INTRA30_TP2_DISTANCE,
  type Intra30Signal,
} from "../src/strategies/intra30Engine";
import {
  getBacktestIntra30Db,
  insertIntra30Row,
  signalToRow,
  updateIntra30Outcome,
  summarizeIntra30,
  isIntra30BacktestValidated,
  intra30RealizedR,
  type Intra30Outcome,
} from "../src/intra30/store";
import type { AssetId, Candle } from "../src/types";

const DEFAULT_FILE = "C:/scalping/data/XAUUSD_M5.json";
const OUT = "data/_intra30_strong_candle_backtest.json";
const SPREAD = 0.25;
const DAYS = 365;
const ASSET: AssetId = "XAUUSD";
const MAX_HOLD_BARS = 96; // 8h M5

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

function applySpread(side: "BUY" | "SELL", open: number, spread: number): number {
  if (spread <= 0) return open;
  return side === "BUY" ? open + spread : open - spread;
}

/** Closed bars through strong + forming tip at entry bar open only. */
function framesAtEntryTip(m5: Candle[], entryIdx: number) {
  const tip = m5[entryIdx];
  const closed = m5.slice(Math.max(0, entryIdx - 400), entryIdx);
  const forming: Candle = {
    time: tip.time,
    open: tip.open,
    high: tip.open,
    low: tip.open,
    close: tip.open,
    volume: 0,
  };
  return { primary: [...closed, forming] };
}

type OpenTrade = {
  sig: Intra30Signal;
  entryIdx: number;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp1Reached: boolean;
  rowId: string;
};

function priceHit(
  side: "BUY" | "SELL",
  bar: Candle,
  sl: number,
  tp1: number,
  tp2: number,
): "SL_HIT" | "TP2_HIT" | "TP1_TOUCH" | null {
  const hitSl = side === "BUY" ? bar.low <= sl : bar.high >= sl;
  const hitTp1 = side === "BUY" ? bar.high >= tp1 : bar.low <= tp1;
  const hitTp2 = side === "BUY" ? bar.high >= tp2 : bar.low <= tp2;
  if (hitSl && (hitTp1 || hitTp2)) return "SL_HIT";
  if (hitSl) return "SL_HIT";
  if (hitTp2) return "TP2_HIT";
  if (hitTp1) return "TP1_TOUCH";
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

  const db = getBacktestIntra30Db(true);
  const usedStrong = new Set<number>();
  const opens: OpenTrade[] = [];

  let signals = 0;
  let unresolved = 0;

  for (let i = Math.max(winStart, 220); i < candles.length - 1; i++) {
    // Resolve existing opens on this closed bar (and prior for weak exit).
    const bar = candles[i];
    const prior = i > 0 ? candles[i - 1] : null;
    const still: OpenTrade[] = [];
    for (const t of opens) {
      let outcome: Intra30Outcome | null = null;
      const px = priceHit(t.sig.direction, bar, t.sl, t.tp1, t.tp2);
      if (px === "SL_HIT") outcome = "SL_HIT";
      else if (px === "TP2_HIT") outcome = "TP2_HIT";
      else if (px === "TP1_TOUCH") t.tp1Reached = true;

      if (!outcome && t.tp1Reached && prior && isWeakCandle(prior)) {
        outcome = "TP1_HIT";
      }
      if (!outcome && i - t.entryIdx >= MAX_HOLD_BARS) {
        // Time stop as TP1 if already banked, else invalidate-ish → count as SL for R
        outcome = t.tp1Reached ? "TP1_HIT" : "SL_HIT";
      }

      if (outcome) {
        updateIntra30Outcome(
          db,
          t.rowId,
          outcome,
          intra30RealizedR(outcome === "SL_HIT" ? "SL_HIT" : outcome),
          bar.time,
        );
      } else {
        still.push(t);
      }
    }
    opens.length = 0;
    opens.push(...still);

    // New signal: tip = next bar after current closed bar i
    const entryIdx = i + 1;
    if (entryIdx >= candles.length) continue;
    const frames = framesAtEntryTip(candles, entryIdx);
    const sig = generateIntra30Signal(ASSET, frames);
    if (!sig) continue;
    if (usedStrong.has(sig.strongBarTime)) continue;
    // Only accept if the strong bar is the bar we just closed (i)
    if (sig.strongBarTime !== candles[i].time) continue;

    usedStrong.add(sig.strongBarTime);
    const entry = applySpread(sig.direction, candles[entryIdx].open, SPREAD);
    const sl =
      sig.direction === "BUY"
        ? entry - INTRA30_SL_DISTANCE
        : entry + INTRA30_SL_DISTANCE;
    const tp1 =
      sig.direction === "BUY"
        ? entry + INTRA30_TP_DISTANCE
        : entry - INTRA30_TP_DISTANCE;
    const tp2 =
      sig.direction === "BUY"
        ? entry + INTRA30_TP2_DISTANCE
        : entry - INTRA30_TP2_DISTANCE;

    const adjusted = {
      ...sig,
      entry,
      sl,
      tp1,
      tp2,
      time: candles[entryIdx].time,
    };
    const row = signalToRow(adjusted, ASSET, "backtest");
    insertIntra30Row(db, row);
    // Mark executed at entry open
    db.prepare(
      `UPDATE intra30_signals SET executed_at = ?, outcome = 'OPEN' WHERE id = ?`,
    ).run(candles[entryIdx].time, row.id);

    opens.push({
      sig: adjusted,
      entryIdx,
      entry,
      sl,
      tp1,
      tp2,
      tp1Reached: false,
      rowId: row.id,
    });
    signals++;
  }

  // Force-close leftovers at end
  for (const t of opens) {
    updateIntra30Outcome(db, t.rowId, "SL_HIT", -1, candles[candles.length - 1].time);
    unresolved++;
  }

  const summary = summarizeIntra30(db);
  const validated = isIntra30BacktestValidated(summary);

  const payload = {
    strategy: "intra30_strong_candle_v1",
    file,
    days: DAYS,
    spread: SPREAD,
    range: { first: loaded.quality.firstIso, last: loaded.quality.lastIso },
    signals,
    forceClosedAtEnd: unresolved,
    summary,
    validated,
    rules: {
      bodyMinPct: 85,
      wickMaxPct: 8,
      firstStrongOfPattern: true,
      tp1: INTRA30_TP_DISTANCE,
      tp2: INTRA30_TP2_DISTANCE,
      sl: INTRA30_SL_DISTANCE,
      weakExitAfterTp1: true,
      multiOpen: true,
    },
    runAt: new Date().toISOString(),
  };

  writeFileSync(OUT, JSON.stringify(payload, null, 2));

  const wr =
    summary.winRate == null ? "n/a" : `${summary.winRate.toFixed(1)}%`;
  const ar =
    summary.avgR == null
      ? "n/a"
      : `${summary.avgR >= 0 ? "+" : ""}${summary.avgR.toFixed(3)}`;

  console.log(`
======== INTRA30 STRONG-CANDLE BACKTEST (365d) ========
Signals fired     : ${signals}
Resolved          : ${summary.resolved}  (W ${summary.wins} / L ${summary.losses})
TP1-win%          : ${wr}
Avg R             : ${ar}
Max DD (R)        : ${summary.maxDrawdownR ?? "n/a"}
Validated badge   : ${validated ? "YES (≥58% / n≥50 / avgR>0)" : "NO"}
Wrote             : ${OUT}
`);

  console.log("Snapshot paste → src/intra30/backtestSnapshot.ts:");
  console.log(
    JSON.stringify(
      {
        resolved: summary.resolved,
        wins: summary.wins,
        losses: summary.losses,
        winRate: summary.winRate,
        avgR: summary.avgR,
        maxDrawdownR: summary.maxDrawdownR,
      },
      null,
      2,
    ),
  );
}

main();
