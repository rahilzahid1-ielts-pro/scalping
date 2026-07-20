/**
 * Walk-forward for compare strategies.
 * Cipher B + Fractal: indicator + SMC dual-confirm via full multi-TF frames.
 */
import type { Candle } from "../types";
import { windowStartIndex } from "../backtest/loadData";
import { framesAtIndex, precomputeHtfs } from "../backtest/frames";
import { generateCipherBLiveSignal } from "../strategies/cipherBLive";
import { generateFractalLiveSignal } from "../strategies/fractalLive";
import { generateIctSignal } from "../strategies/archived/ictSignal";
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

const MIN_BARS = 250;

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

function emitSignal(
  strategy: CompareStrategy,
  frames: {
    primary: Candle[];
    confirmation: Candle[];
    bias: Candle[];
    daily: Candle[];
  },
  symbol: "XAUUSD",
): Emitted | null {
  try {
    if (strategy === "cipher_b_clone") {
      return generateCipherBLiveSignal({
        ...frames,
        assetId: symbol,
        mode: "scalping",
      });
    }
    if (strategy === "fractal") {
      return generateFractalLiveSignal({
        ...frames,
        assetId: symbol,
        mode: "scalping",
      });
    }
    const sig = generateIctSignal({ candles: candlesAsUnixSeconds(frames.primary) });
    if (!sig) return null;
    return { ...sig, time: frames.primary[frames.primary.length - 1].time };
  } catch {
    return null;
  }
}

export function runCompareStrategyBacktest(
  opts: CompareBacktestOptions,
): CompareBacktestStats {
  const days = opts.days ?? 365;
  const spread = opts.spread ?? 0.25;
  const symbol = (opts.symbol ?? "XAUUSD") as "XAUUSD";
  const cooldown = opts.cooldownBars ?? 24;
  const m5 = opts.candles;
  const start = windowStartIndex(m5, days);
  const strategy = opts.strategy;
  const htfs = precomputeHtfs(m5);

  const db = getBacktestStrategyDb(false);
  db.prepare(
    `DELETE FROM strategy_signals WHERE strategy = ? AND source = 'backtest'`,
  ).run(strategy);

  let open: { row: StrategySignalRow; fromIndex: number } | null = null;
  let lastSignalIndex = -cooldown;
  let signals = 0;

  for (let i = Math.max(start, MIN_BARS); i < m5.length; i++) {
    if (open) {
      const risk = Math.abs(open.row.entry - open.row.sl);
      const tp1R =
        risk > 0 ? Math.abs(open.row.tp1 - open.row.entry) / risk : 1;
      const res = resolveOnBars(
        open.row.direction,
        open.row.sl,
        open.row.tp1,
        m5,
        open.fromIndex,
      );
      if (res) {
        const realizedR = res.outcome === "TP1_HIT" ? tp1R : -1;
        updateStrategyOutcome(db, open.row.id, res.outcome, realizedR, res.at);
        open = null;
      }
    }

    if (open) continue;
    if (i - lastSignalIndex < cooldown) continue;

    const packed = framesAtIndex(m5, i, "scalping", htfs);
    if (!packed) continue;

    const sig = emitSignal(
      strategy,
      {
        primary: packed.primary,
        confirmation: packed.confirmation,
        bias: packed.bias,
        daily: packed.daily,
      },
      symbol,
    );
    if (!sig) continue;

    const entry = applySpread(sig.direction, sig.entry, spread);
    const risk = Math.abs(sig.entry - sig.sl);
    const tp1Mult = risk > 0 ? Math.abs(sig.tp1 - sig.entry) / risk : 0.9;
    const tp2Mult = risk > 0 ? Math.abs(sig.tp2 - sig.entry) / risk : 1.6;
    let sl = sig.sl;
    let tp1 = sig.tp1;
    let tp2 = sig.tp2;
    if (sig.direction === "BUY") {
      sl = entry - risk;
      tp1 = entry + risk * tp1Mult;
      tp2 = entry + risk * tp2Mult;
    } else {
      sl = entry + risk;
      tp1 = entry - risk * tp1Mult;
      tp2 = entry - risk * tp2Mult;
    }

    const row = makeStrategyRow({
      strategy,
      direction: sig.direction,
      entry,
      sl,
      tp1,
      tp2,
      reason: sig.reason,
      time: m5[i].time,
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
