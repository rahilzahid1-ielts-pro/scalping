/**
 * QS Pro (Pulse) walk-forward — SMC + fractal-agree + 0.85R TP1.
 */
import type { Candle } from "../types";
import { generatePulseSignal } from "../strategies/pulseEngine";
import { framesAtIndex, precomputeHtfs } from "../backtest/frames";
import { windowStartIndex } from "../backtest/loadData";
import {
  getBacktestPulseDb,
  insertPulseRow,
  listPulseRows,
  signalToRow,
  summarizePulse,
  updatePulseOutcome,
  type PulseRow,
} from "./store";

export interface PulseBacktestOptions {
  candles: Candle[];
  days?: number;
  spread?: number;
  symbol?: string;
  /** Default 24 M5 bars ≈ 2h */
  cooldownBars?: number;
}

export interface PulseBacktestStats {
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

function resolveOnBars(
  row: PulseRow,
  bars: Candle[],
  fromIndex: number,
): { outcome: "TP1_HIT" | "SL_HIT"; realizedR: number; at: number } | null {
  const buy = row.direction === "BUY";
  const risk = Math.abs(row.entry - row.sl);
  const tp1R = risk > 0 ? Math.abs(row.tp1 - row.entry) / risk : 0.85;
  for (let i = fromIndex; i < bars.length; i++) {
    const b = bars[i];
    const hitSl = buy ? b.low <= row.sl : b.high >= row.sl;
    const hitTp = buy ? b.high >= row.tp1 : b.low <= row.tp1;
    if (hitSl && hitTp) return { outcome: "SL_HIT", realizedR: -1, at: b.time };
    if (hitSl) return { outcome: "SL_HIT", realizedR: -1, at: b.time };
    if (hitTp) return { outcome: "TP1_HIT", realizedR: tp1R, at: b.time };
  }
  return null;
}

export function runPulseBacktest(opts: PulseBacktestOptions): PulseBacktestStats {
  const days = opts.days ?? 365;
  const spread = opts.spread ?? 0.25;
  const symbol = (opts.symbol ?? "XAUUSD") as "XAUUSD";
  const cooldown = opts.cooldownBars ?? 24;
  const m5 = opts.candles;
  const start = windowStartIndex(m5, days);
  const db = getBacktestPulseDb(true);
  const htfs = precomputeHtfs(m5);

  let open: { row: PulseRow; fromIndex: number } | null = null;
  let lastSignalIndex = -cooldown;
  let signals = 0;

  for (let i = Math.max(start, 250); i < m5.length; i++) {
    if (open) {
      const res = resolveOnBars(open.row, m5, open.fromIndex);
      if (res) {
        updatePulseOutcome(db, open.row.id, res.outcome, res.realizedR, res.at);
        open = null;
      }
    }
    if (open) continue;
    if (i - lastSignalIndex < cooldown) continue;

    const frames = framesAtIndex(m5, i, "scalping", htfs);
    if (!frames) continue;

    let sig;
    try {
      sig = generatePulseSignal(
        {
          primary: frames.primary,
          confirmation: frames.confirmation,
          bias: frames.bias,
          daily: frames.daily,
        },
        symbol,
        "scalping",
      );
    } catch {
      continue;
    }
    if (!sig) continue;

    sig = { ...sig, time: m5[i].time };
    const entry = applySpread(sig.direction, sig.entry, spread);
    const risk = Math.abs(sig.entry - sig.sl);
    const adjusted = { ...sig, entry };
    if (sig.direction === "BUY") {
      adjusted.sl = entry - risk;
      adjusted.tp1 = entry + risk * (Math.abs(sig.tp1 - sig.entry) / risk);
      adjusted.tp2 = entry + risk * (Math.abs(sig.tp2 - sig.entry) / risk);
    } else {
      adjusted.sl = entry + risk;
      adjusted.tp1 = entry - risk * (Math.abs(sig.entry - sig.tp1) / risk);
      adjusted.tp2 = entry - risk * (Math.abs(sig.entry - sig.tp2) / risk);
    }

    const row = signalToRow(adjusted, symbol, "backtest");
    insertPulseRow(db, row);
    open = { row, fromIndex: i + 1 };
    lastSignalIndex = i;
    signals += 1;
  }

  const all = listPulseRows(db);
  const summary = summarizePulse(db);
  return {
    signals,
    resolved: summary.resolved,
    wins: summary.wins,
    losses: summary.losses,
    winRate: summary.winRate,
    avgR: summary.avgR,
    maxDrawdownR: summary.maxDrawdownR,
    openLeft: all.filter((r) => r.outcome === "OPEN").length,
  };
}
