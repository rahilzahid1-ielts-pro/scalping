/**
 * Generic walk-forward for single-TF compare strategies (cipher_b_clone / ict / fractal).
 * Does NOT call generateSignal / session-lock / main backtest engine.
 * Does NOT touch quick_scalp_signals.
 */
import type { Candle } from "../types";
import { windowStartIndex } from "../backtest/loadData";
import { generateCipherBSignal } from "../strategies/archived/cipherBSignal";
import { generateIctSignal } from "../strategies/archived/ictSignal";
import { generateFractalSignal } from "../strategies/archived/fractalSignal";
import { candlesAsUnixSeconds, resolveOnBars } from "./resolve";
import {
  getBacktestStrategyDb,
  insertStrategyRow,
  listStrategyRows,
  makeStrategyRow,
  summarizeStrategy,
  updateStrategyOutcome,
  type CompareStrategy,
  type StrategySignalRow,
} from "./store";

const MIN_BARS = 80;

export interface CompareBacktestOptions {
  candles: Candle[];
  strategy: CompareStrategy;
  days?: number;
  spread?: number;
  symbol?: string;
  cooldownBars?: number;
}

export interface CompareBacktestStats {
  signals: number;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  maxDrawdownR: number | null;
  openLeft: number;
}

function applySpread(side: "BUY" | "SELL", entry: number, spread: number): number {
  if (spread <= 0) return entry;
  return side === "BUY" ? entry + spread : entry - spread;
}

type Emitted = {
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  reason: string[];
  time: number;
};

function emitSignal(strategy: CompareStrategy, window: Candle[]): Emitted | null {
  try {
    if (strategy === "cipher_b_clone") {
      const sig = generateCipherBSignal({ candles: window });
      return sig;
    }
    if (strategy === "fractal") {
      const sig = generateFractalSignal({ candles: window });
      return sig;
    }
    // ICT expects unix seconds for killzone hour
    const sig = generateIctSignal({ candles: candlesAsUnixSeconds(window) });
    if (!sig) return null;
    // Restore ms timestamp for storage consistency with the rest of the project
    const last = window[window.length - 1];
    return { ...sig, time: last.time };
  } catch {
    return null;
  }
}

export function runCompareStrategyBacktest(
  opts: CompareBacktestOptions,
): CompareBacktestStats {
  const days = opts.days ?? 365;
  const spread = opts.spread ?? 0.25;
  const symbol = opts.symbol ?? "XAUUSD";
  const cooldown = opts.cooldownBars ?? 12;
  const m5 = opts.candles;
  const start = windowStartIndex(m5, days);
  const strategy = opts.strategy;

  const db = getBacktestStrategyDb(false);
  // Clear only this strategy's prior backtest rows (leave other strategies intact).
  db.prepare(
    `DELETE FROM strategy_signals WHERE strategy = ? AND source = 'backtest'`,
  ).run(strategy);

  let open: { row: StrategySignalRow; fromIndex: number } | null = null;
  let lastSignalIndex = -cooldown;
  let signals = 0;

  for (let i = Math.max(start, MIN_BARS); i < m5.length; i++) {
    if (open) {
      const res = resolveOnBars(
        open.row.direction,
        open.row.sl,
        open.row.tp1,
        m5,
        open.fromIndex,
      );
      if (res) {
        updateStrategyOutcome(db, open.row.id, res.outcome, res.realizedR, res.at);
        open = null;
      }
    }

    if (open) continue;
    if (i - lastSignalIndex < cooldown) continue;

    const window = m5.slice(Math.max(0, i + 1 - 400), i + 1);
    if (window.length < MIN_BARS) continue;

    const sig = emitSignal(strategy, window);
    if (!sig) continue;

    const entry = applySpread(sig.direction, sig.entry, spread);
    const risk = Math.abs(sig.entry - sig.sl);
    let sl = sig.sl;
    let tp1 = sig.tp1;
    let tp2 = sig.tp2;
    if (sig.direction === "BUY") {
      sl = entry - risk;
      tp1 = entry + risk;
      tp2 = entry + risk * 2;
    } else {
      sl = entry + risk;
      tp1 = entry - risk;
      tp2 = entry - risk * 2;
    }

    const row = makeStrategyRow({
      strategy,
      direction: sig.direction,
      entry,
      sl,
      tp1,
      tp2,
      reason: sig.reason,
      time: sig.time,
      symbol,
      source: "backtest",
    });
    insertStrategyRow(db, row);
    open = { row, fromIndex: i + 1 };
    lastSignalIndex = i;
    signals += 1;
  }

  const all = listStrategyRows(db, strategy);
  const summary = summarizeStrategy(db, strategy);
  const openLeft = all.filter((r) => r.outcome === "OPEN").length;

  return {
    signals,
    resolved: summary.resolved,
    wins: summary.wins,
    losses: summary.losses,
    winRate: summary.winRate,
    avgR: summary.avgR,
    maxDrawdownR: summary.maxDrawdownR,
    openLeft,
  };
}
