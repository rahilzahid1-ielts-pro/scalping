/**
 * Intra30 Step-2 session-lock backtest (TP $3 / SL $6 as coded).
 *
 *   npx tsx scripts/backtestIntra30SessionLock.ts
 *
 * Same pipeline as Main Intraday / sessionLockAllModules:
 * canAutoLockPlan → createFrozenPlan → zone-touch → SL-first.
 * Candidate = generateIntra30Signal (Intraday gates + fixed exits).
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { loadHistoricalFile, windowStartIndex } from "../src/backtest/loadData";
import {
  closeBacktestDb,
  getBacktestDbPath,
  listBacktestSignals,
  openBacktestDb,
} from "../src/backtest/store";
import {
  conditionalTp1WinRate,
  longestLosingStreak,
  maxDrawdownR,
  runWalkForward,
  zoneTouchRate,
  type SessionLockCandidateFn,
} from "../src/backtest/engine";
import type { AssetId, LiveSignal, TradeLevels, TradeMode } from "../src/types";
import { generateSignal } from "../src/strategies/signalEngine";
import { generateIntra30Signal } from "../src/strategies/intra30Engine";
import {
  INTRA30_SL_DISTANCE,
  INTRA30_TP_DISTANCE,
} from "../src/strategies/intra30Engine";
import { setWaitingTooLateMode } from "../src/services/tradePlan";

const DEFAULT_FILE = "C:/scalping/data/XAUUSD_M5.json";
const OUT = "data/_intra30_session_lock_backtest.json";
const SPREAD = 0.25;
const DAYS = 365;
const ASSET: AssetId = "XAUUSD";
const LOW_N = 50;
const MODE: TradeMode = "intraday";
const REJECT_ALREADY_MISSED = true;

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

function levelsFromModule(
  entry: number,
  sl: number,
  tp1: number,
  tp2: number,
): TradeLevels {
  const risk = Math.abs(entry - sl);
  return {
    entry,
    stopLoss: sl,
    takeProfit1: tp1,
    takeProfit2: tp2,
    takeProfit3: tp2,
    riskReward: risk > 0 ? Math.abs(tp1 - entry) / risk : 0,
    invalidation: sl,
  };
}

const intra30Candidate: SessionLockCandidateFn = (frames, mode, assetId) => {
  const shell = generateSignal(assetId, mode, frames);
  const sig = generateIntra30Signal(assetId, frames);
  if (!sig) return null;
  return {
    ...shell,
    side: sig.direction,
    confidence: sig.confidence,
    levels: levelsFromModule(sig.entry, sig.sl, sig.tp1, sig.tp2),
    rangePrediction: {
      ...shell.rangePrediction,
      winProbability: Math.max(
        shell.rangePrediction.winProbability,
        sig.confidence,
      ),
    },
  } satisfies LiveSignal;
};

function resetDb() {
  closeBacktestDb();
  const p = getBacktestDbPath();
  for (const f of [p, p + "-wal", p + "-shm"]) {
    if (existsSync(f)) {
      try {
        unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }
  return openBacktestDb(true);
}

function main() {
  const file = argValue(process.argv.slice(2), "--file") ?? DEFAULT_FILE;
  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  setWaitingTooLateMode("legacy_nested");

  console.log(`Loading ${file}…`);
  const loaded = loadHistoricalFile(file);
  const candles = loaded.candles;
  const winStart = windowStartIndex(candles, DAYS);

  console.log(`
Intra30 Step-2 session-lock (as coded TP $${INTRA30_TP_DISTANCE} / SL $${INTRA30_SL_DISTANCE})
────────────────────────────────────────────────────────────
File       : ${file}
Range      : ${loaded.quality.firstIso} → ${loaded.quality.lastIso}
Bars       : ${loaded.quality.bars}
Window     : last ${DAYS}d (start idx ${winStart})
Spread     : ${SPREAD}
Resolution : canAutoLockPlan → createFrozenPlan → zone-touch → SL-first
Candidate  : generateIntra30Signal (Intraday gates + fixed exits)
`);

  const db = resetDb();
  const t0 = Date.now();
  const stats = runWalkForward(db, candles, {
    assetId: ASSET,
    modes: [MODE],
    spread: SPREAD,
    windowStartIdx: winStart,
    trendConfirmBars: 4,
    rejectAlreadyMissed: REJECT_ALREADY_MISSED,
    signalCandidate: intra30Candidate,
    onProgress: (done, total) => {
      if (done === 0 || done === total || done % 10000 === 0) {
        process.stdout.write(
          `\r  Intra30 ${done}/${total} (${((done / total) * 100).toFixed(0)}%)   `,
        );
      }
    },
  });
  process.stdout.write("\n");

  const signals = listBacktestSignals(db);
  const touched = signals.filter((s) => s.zoneTouchedAt != null);
  const resolved = touched.filter(
    (s) => s.outcomeTp1 === "WIN" || s.outcomeTp1 === "LOSS",
  );
  const tp1Hits = resolved.filter((s) => s.outcomeTp1 === "WIN").length;
  const slHits = resolved.filter((s) => s.outcomeTp1 === "LOSS").length;

  const avgRFull = (() => {
    const closed = touched.filter(
      (s) => s.fullPlanClosed && s.realizedRFull != null,
    );
    if (!closed.length) return null;
    return (
      closed.reduce((a, s) => a + (s.realizedRFull as number), 0) / closed.length
    );
  })();
  const avgRTp1 = (() => {
    const withR = resolved.filter((s) => s.realizedR != null);
    if (!withR.length) return null;
    return withR.reduce((a, s) => a + (s.realizedR as number), 0) / withR.length;
  })();

  const zoneTouchPct = zoneTouchRate(stats);
  const winRate = conditionalTp1WinRate(stats);
  const avgR = avgRFull ?? avgRTp1;
  const maxDd = maxDrawdownR(stats.equityR);

  const row = {
    id: "intra30",
    label: "Intra30",
    mode: MODE,
    tpDistance: INTRA30_TP_DISTANCE,
    slDistance: INTRA30_SL_DISTANCE,
    locked: stats.signalsFired,
    zoneTouched: stats.zoneTouched,
    zoneTouchPct,
    executedN: touched.length,
    executedResolved: resolved.length,
    tp1Hits,
    slHits,
    tp1WinPct: winRate,
    avgR,
    avgR_tp1: avgRTp1,
    avgR_full: avgRFull,
    maxDrawdownR: maxDd,
    longestLosingStreak: longestLosingStreak(signals),
    lowConfidence: touched.length < LOW_N,
    elapsedSec: (Date.now() - t0) / 1000,
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    method:
      "runWalkForward session-lock (trusted baseline). Intra30 candidate = generateIntra30Signal (Intraday entry gates + TP $3 / SL $6). Zone-touch required. Reject-missed ON, 0.5R wait-invalidation OFF.",
    file,
    days: DAYS,
    spread: SPREAD,
    windowStartIdx: winStart,
    windowStartIso: new Date(candles[winStart]?.time ?? 0).toISOString(),
    result: row,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log(`\nWrote ${OUT}`);
  console.log("\n======== INTRA30 SESSION-LOCK ========");
  console.log(
    `locked=${row.locked}  zone-touch%=${
      zoneTouchPct == null ? "n/a" : zoneTouchPct.toFixed(1) + "%"
    }  executed n=${row.executedN}  TP1-win%=${
      winRate == null ? "n/a" : winRate.toFixed(1) + "%"
    }  avgR=${
      avgR == null ? "n/a" : (avgR >= 0 ? "+" : "") + avgR.toFixed(3)
    }  maxDD=${maxDd == null ? "n/a" : maxDd.toFixed(2) + "R"}` +
      (row.lowConfidence ? "  ⚠ LOW CONFIDENCE" : ""),
  );
}

main();
