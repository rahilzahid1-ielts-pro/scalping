/**
 * Isolated Pro walk-forward backtest (generateSignal + Pro gates).
 * Does NOT touch main session-lock backtest or quick_scalp_signals.
 */
import type { Candle } from "../types";
import { generateProSignal } from "../strategies/proEngine";
import {
  framesAtIndex,
  isClosedFifteenEnd,
  precomputeHtfs,
} from "../backtest/frames";
import { windowStartIndex } from "../backtest/loadData";
import {
  getBacktestProDb,
  insertProRow,
  listProRows,
  signalToRow,
  summarizePro,
  updateProOutcome,
  type ProRow,
} from "./store";

export interface ProBacktestOptions {
  candles: Candle[];
  days?: number;
  spread?: number;
  symbol?: string;
  /** Cooldown bars after a signal (M5 bars). Default 36 = 3h. */
  cooldownBars?: number;
}

export interface ProBacktestStats {
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
  row: ProRow,
  bars: Candle[],
  fromIndex: number,
): { outcome: "TP1_HIT" | "SL_HIT"; realizedR: number; at: number } | null {
  const buy = row.direction === "BUY";
  for (let i = fromIndex; i < bars.length; i++) {
    const b = bars[i];
    const hitSl = buy ? b.low <= row.sl : b.high >= row.sl;
    const hitTp = buy ? b.high >= row.tp1 : b.low <= row.tp1;
    if (hitSl && hitTp) {
      return { outcome: "SL_HIT", realizedR: -1, at: b.time };
    }
    if (hitSl) return { outcome: "SL_HIT", realizedR: -1, at: b.time };
    if (hitTp) return { outcome: "TP1_HIT", realizedR: 1, at: b.time };
  }
  return null;
}

export function runProBacktest(opts: ProBacktestOptions): ProBacktestStats {
  const days = opts.days ?? 365;
  const spread = opts.spread ?? 0.25;
  const symbol = opts.symbol ?? "XAUUSD";
  const cooldown = opts.cooldownBars ?? 36;
  const m5 = opts.candles;
  const start = windowStartIndex(m5, days);

  const db = getBacktestProDb(true);
  const htfs = precomputeHtfs(m5);

  let open: { row: ProRow; fromIndex: number } | null = null;
  let lastSignalIndex = -cooldown;
  let signals = 0;

  for (let i = Math.max(start, 250); i < m5.length; i++) {
    if (open) {
      const res = resolveOnBars(open.row, m5, open.fromIndex);
      if (res) {
        updateProOutcome(db, open.row.id, res.outcome, res.realizedR, res.at);
        open = null;
      }
    }

    if (open) continue;
    if (i - lastSignalIndex < cooldown) continue;
    // Intraday Pro uses M15 primary — only evaluate on closed 15m bars.
    if (!isClosedFifteenEnd(m5, i)) continue;

    const frames = framesAtIndex(m5, i, "intraday", htfs);
    if (!frames) continue;

    let sig;
    try {
      sig = generateProSignal(symbol as "XAUUSD", {
        primary: frames.primary,
        confirmation: frames.confirmation,
        bias: frames.bias,
        daily: frames.daily,
      }, "intraday");
    } catch {
      continue;
    }
    if (!sig) continue;

    // Stamp bar time for stable ids in walk-forward
    sig = { ...sig, time: m5[i].time };

    const entry = applySpread(sig.direction, sig.entry, spread);
    const risk = Math.abs(sig.entry - sig.sl);
    const adjusted = { ...sig, entry };
    if (sig.direction === "BUY") {
      adjusted.sl = entry - risk;
      adjusted.tp1 = entry + risk * (Math.abs(sig.tp1 - sig.entry) / risk || 1);
      adjusted.tp2 = entry + risk * (Math.abs(sig.tp2 - sig.entry) / risk || 2);
    } else {
      adjusted.sl = entry + risk;
      adjusted.tp1 = entry - risk * (Math.abs(sig.entry - sig.tp1) / risk || 1);
      adjusted.tp2 = entry - risk * (Math.abs(sig.entry - sig.tp2) / risk || 2);
    }

    const row = signalToRow(adjusted, symbol, "backtest");
    insertProRow(db, row);
    open = { row, fromIndex: i + 1 };
    lastSignalIndex = i;
    signals += 1;
  }

  const all = listProRows(db);
  const summary = summarizePro(db);
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
