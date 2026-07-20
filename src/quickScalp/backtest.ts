/**
 * Isolated Quick Scalp walk-forward backtest.
 * Does NOT call generateSignal / session-lock / main backtest engine.
 */
import type { Candle } from "../types";
import { generateQuickScalpSignal } from "../strategies/quickScalpEngine";
import { precomputeHtfs, onlyFullyClosed } from "../backtest/frames";
import { windowStartIndex } from "../backtest/loadData";
import {
  getBacktestQuickScalpDb,
  insertQuickScalpRow,
  listQuickScalpRows,
  signalToRow,
  summarizeQuickScalp,
  updateQuickScalpOutcome,
  type QuickScalpRow,
} from "./store";

const M5_MS = 5 * 60 * 1000;
const D1_MS = 24 * 60 * 60 * 1000;
const MIN_M5 = 80;
const MIN_DAILY = 55;

export interface QuickScalpBacktestOptions {
  candles: Candle[];
  days?: number;
  spread?: number;
  symbol?: string;
  /** Cooldown bars after a signal before allowing another (avoid same-setup spam). */
  cooldownBars?: number;
}

export interface QuickScalpBacktestStats {
  signals: number;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  maxDrawdownR: number | null;
  openLeft: number;
}

function applySpread(
  side: "BUY" | "SELL",
  entry: number,
  spread: number,
): number {
  if (spread <= 0) return entry;
  return side === "BUY" ? entry + spread : entry - spread;
}

/** First-touch: SL vs TP1 on subsequent bars (ties prefer SL, matching live rules). */
function resolveOnBars(
  row: QuickScalpRow,
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

export function runQuickScalpBacktest(opts: QuickScalpBacktestOptions): QuickScalpBacktestStats {
  const days = opts.days ?? 365;
  const spread = opts.spread ?? 0.25;
  const symbol = opts.symbol ?? "XAUUSD";
  const cooldown = opts.cooldownBars ?? 12; // 1 hour on M5
  const m5 = opts.candles;
  const start = windowStartIndex(m5, days);

  const db = getBacktestQuickScalpDb(true);
  const htfs = precomputeHtfs(m5);

  let open: { row: QuickScalpRow; fromIndex: number } | null = null;
  let lastSignalIndex = -cooldown;
  let signals = 0;

  for (let i = Math.max(start, MIN_M5); i < m5.length; i++) {
    // Resolve open trade first
    if (open) {
      const res = resolveOnBars(open.row, m5, open.fromIndex);
      if (res) {
        updateQuickScalpOutcome(db, open.row.id, res.outcome, res.realizedR, res.at);
        open = null;
      }
    }

    if (open) continue; // one open at a time
    if (i - lastSignalIndex < cooldown) continue;

    const periodMs = i + 1 < m5.length ? m5[i + 1].time - m5[i].time : M5_MS;
    const asOfCloseMs = m5[i].time + periodMs;
    const daily = onlyFullyClosed(htfs.daily, D1_MS, asOfCloseMs);
    if (daily.length < MIN_DAILY) continue;

    const m5Window = m5.slice(Math.max(0, i + 1 - 400), i + 1);
    if (m5Window.length < MIN_M5) continue;

    let sig;
    try {
      sig = generateQuickScalpSignal({ m5Candles: m5Window, dailyCandles: daily });
    } catch {
      continue;
    }
    if (!sig) continue;

    const entry = applySpread(sig.direction, sig.entry, spread);
    const adjusted = { ...sig, entry };
    // Keep SL/TP relative risk from original entry distance
    const risk = Math.abs(sig.entry - sig.sl);
    if (sig.direction === "BUY") {
      adjusted.sl = entry - risk;
      adjusted.tp1 = entry + risk;
      adjusted.tp2 = entry + risk * 2;
    } else {
      adjusted.sl = entry + risk;
      adjusted.tp1 = entry - risk;
      adjusted.tp2 = entry - risk * 2;
    }

    const row = signalToRow(adjusted, symbol, "backtest");
    insertQuickScalpRow(db, row);
    open = { row, fromIndex: i + 1 };
    lastSignalIndex = i;
    signals += 1;
  }

  // Leave still-open as OPEN (counted separately)
  const all = listQuickScalpRows(db);
  const summary = summarizeQuickScalp(db);
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
