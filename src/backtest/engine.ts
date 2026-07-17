import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AssetId, Candle, TradeMode } from "../types";
import { ASSETS } from "../config/assets";
import { generateSignal } from "../strategies/signalEngine";
import { makePlanKey } from "../calibration/db";
import { advanceSignalOnBar } from "../calibration/resolveOutcomes";
import type { LoggedSignal } from "../calibration/types";
import { entryTolerance, isTooLateToEnter } from "../utils/tradeSafety";
import { framesAtIndex, isClosedFifteenEnd, precomputeHtfs } from "./frames";
import { insertBacktestSignal, updateBacktestSignal } from "./store";

const LOCK_MIN_CONFIDENCE = 68; // matches App.tsx auto-lock threshold

export interface BacktestOptions {
  assetId: AssetId;
  modes: TradeMode[];
  /** Price units (Gold $). BUY entry += spread, SELL entry -= spread. */
  spread: number;
  /** First M5 index inside the reported window (warmup bars before this exist). */
  windowStartIdx: number;
  onProgress?: (done: number, total: number) => void;
}

export interface BacktestStats {
  signalsFired: number;
  byMonth: Map<string, number>;
  equityR: number[];
}

type PendingPlan = {
  row: LoggedSignal;
  filled: boolean;
  signalBarIndex: number;
};

const MAX_WAIT_BARS_SCALP = 36; // 3h of M5
const MAX_WAIT_BARS_INTRA = 96; // 8h of M5

function applySpread(
  side: "BUY" | "SELL",
  entry: number,
  spread: number,
): number {
  if (spread <= 0) return entry;
  return side === "BUY" ? entry + spread : entry - spread;
}

function toLogged(
  signal: ReturnType<typeof generateSignal>,
  entry: number,
  ts: number,
): LoggedSignal | null {
  if (signal.side !== "BUY" && signal.side !== "SELL") return null;
  if (!signal.levels) return null;
  const d = signal.diagnostics;
  const planKey = makePlanKey(
    signal.asset,
    signal.mode,
    signal.side,
    entry,
    signal.levels.stopLoss,
    signal.levels.takeProfit1,
  );
  return {
    id: randomUUID(),
    timestamp: ts,
    symbol: signal.asset,
    mode: signal.mode,
    side: signal.side,
    entry,
    sl: signal.levels.stopLoss,
    tp1: signal.levels.takeProfit1,
    tp2: signal.levels.takeProfit2,
    tp3: signal.levels.takeProfit3,
    confidence: signal.confidence,
    winChanceDisplayed: signal.rangePrediction.winProbability,
    winChanceCalibrated: null,
    confluencePct: d.confluencePct,
    smcScore: d.smcScore,
    maScore: d.maScore,
    paScore: d.paScore,
    bullPts: d.bullPts,
    bearPts: d.bearPts,
    htfAligned: d.htfAligned,
    dailyBias: signal.dailyBias.bias,
    conflictingSignals: d.conflictingSignals,
    conflictCapped: d.conflictCapped,
    planKey,
    outcome: "OPEN",
    outcomeTp1: null,
    resolvedAt: null,
    realizedR: null,
    realizedRFull: null,
    fullPlanClosed: false,
    tp2Hit: false,
    tp3Hit: false,
    slAfterTp1: false,
    tp1HitAt: null,
    tp2HitAt: null,
    tp3HitAt: null,
    slAfterTp1At: null,
    atr14: d.atr14,
    atrPctOfPrice: d.atrPctOfPrice,
    regime: d.regime,
  };
}

function monthKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

function barTouchesEntry(
  side: "BUY" | "SELL",
  bar: Candle,
  entry: number,
  tol: number,
): boolean {
  if (side === "BUY") {
    return bar.low <= entry + tol && bar.high >= entry - tol * 1.2;
  }
  return bar.high >= entry - tol && bar.low <= entry + tol * 1.2;
}

/**
 * Walk-forward backtest using production `generateSignal` + `advanceSignalOnBar`.
 * One open plan per mode. Fills only after price touches entry (live WAIT→ENTER).
 */
export function runWalkForward(
  db: Database.Database,
  m5: Candle[],
  opts: BacktestOptions,
): BacktestStats {
  const pendingByMode = new Map<TradeMode, PendingPlan>();
  const stats: BacktestStats = {
    signalsFired: 0,
    byMonth: new Map(),
    equityR: [],
  };

  let equity = 0;
  const total = m5.length;
  const htfs = precomputeHtfs(m5);
  const asset = ASSETS[opts.assetId];

  for (let i = 0; i < m5.length; i++) {
    const bar = m5[i];
    const periodMs =
      i + 1 < m5.length ? m5[i + 1].time - bar.time : 5 * 60 * 1000;
    const asOfClose = bar.time + periodMs;
    const tick = {
      price: bar.close,
      open: bar.open,
      high: bar.high,
      low: bar.low,
    };

    for (const mode of opts.modes) {
      const pending = pendingByMode.get(mode);
      if (!pending) continue;

      const { row } = pending;
      const tol = entryTolerance(asset, mode, row.entry);

      if (!pending.filled) {
        const maxWait =
          mode === "scalping" ? MAX_WAIT_BARS_SCALP : MAX_WAIT_BARS_INTRA;
        const waited = i - pending.signalBarIndex;

        if (
          waited > maxWait ||
          isTooLateToEnter(row.side, bar.close, row.entry, row.sl) ||
          (row.side === "BUY" && bar.low <= row.sl) ||
          (row.side === "SELL" && bar.high >= row.sl)
        ) {
          row.outcome = "INVALIDATED";
          row.resolvedAt = asOfClose;
          row.realizedR = 0;
          row.realizedRFull = 0;
          row.fullPlanClosed = true;
          row.resolveNote =
            waited > maxWait
              ? `Entry timeout after ${waited} bars`
              : "Entry never filled / too late / SL before entry";
          updateBacktestSignal(db, row);
          pendingByMode.delete(mode);
          continue;
        }

        if (barTouchesEntry(row.side, bar, row.entry, tol)) {
          pending.filled = true;
          const next = advanceSignalOnBar({ ...row }, tick, asOfClose);
          if (next) {
            updateBacktestSignal(db, next);
            if (next.outcomeTp1 === "LOSS" || next.fullPlanClosed) {
              const r = next.realizedRFull ?? next.realizedR ?? 0;
              equity += r;
              stats.equityR.push(equity);
              pendingByMode.delete(mode);
            } else {
              pendingByMode.set(mode, { row: next, filled: true });
            }
          } else {
            pendingByMode.set(mode, pending);
          }
        }
        continue;
      }

      const next = advanceSignalOnBar({ ...row }, tick, asOfClose);
      if (next) {
        updateBacktestSignal(db, next);
        if (next.outcomeTp1 === "LOSS" || next.fullPlanClosed) {
          const r = next.realizedRFull ?? next.realizedR ?? 0;
          equity += r;
          stats.equityR.push(equity);
          pendingByMode.delete(mode);
        } else {
          pendingByMode.set(mode, { row: next, filled: true });
        }
      }
    }

    if (i < opts.windowStartIdx) {
      if (i % 2000 === 0) opts.onProgress?.(i, total);
      continue;
    }

    for (const mode of opts.modes) {
      if (pendingByMode.has(mode)) continue;
      if (mode === "intraday" && !isClosedFifteenEnd(m5, i)) continue;

      const frames = framesAtIndex(m5, i, mode, htfs);
      if (!frames) continue;

      const signal = generateSignal(opts.assetId, mode, frames);
      if (signal.side === "WAIT" || !signal.levels) continue;
      if (signal.confidence < LOCK_MIN_CONFIDENCE) continue;

      const entry = applySpread(signal.side, signal.levels.entry, opts.spread);
      const row = toLogged(signal, entry, asOfClose);
      if (!row) continue;

      insertBacktestSignal(db, row);
      pendingByMode.set(mode, { row, filled: false, signalBarIndex: i });
      stats.signalsFired += 1;
      const mk = monthKey(asOfClose);
      stats.byMonth.set(mk, (stats.byMonth.get(mk) ?? 0) + 1);
    }

    if (i % 2000 === 0) opts.onProgress?.(i, total);
  }

  opts.onProgress?.(total, total);
  return stats;
}

/** Max drawdown in R from equity curve (cumulative realizedRFull). */
export function maxDrawdownR(equityCurve: number[]): number {
  if (equityCurve.length === 0) return 0;
  let peak = equityCurve[0];
  let maxDd = 0;
  for (const e of equityCurve) {
    if (e > peak) peak = e;
    const dd = peak - e;
    if (dd > maxDd) maxDd = dd;
  }
  return Math.round(maxDd * 1000) / 1000;
}

/** Longest consecutive TP1 LOSS streak. */
export function longestLosingStreak(signals: LoggedSignal[]): number {
  let best = 0;
  let cur = 0;
  const resolved = signals
    .filter((s) => s.outcomeTp1 === "WIN" || s.outcomeTp1 === "LOSS")
    .sort((a, b) => (a.resolvedAt ?? a.timestamp) - (b.resolvedAt ?? b.timestamp));
  for (const s of resolved) {
    if (s.outcomeTp1 === "LOSS") {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}
