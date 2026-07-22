/**
 * Strong Candle — measurement-only engine (no live tab/bot/API wiring).
 * Backtest: npx tsx scripts/backtestStrongCandle.ts
 *
 * Rules:
 *   1. Last closed M5 candle is "strong" (no wick / very tiny wicks, body dominates).
 *   2. Last closed H1 candle must be the SAME color as that M5 candle.
 *   3. Trade direction follows M5 (green → BUY, red → SELL).
 *   4. TP = entry ± $3.00 (30 points), SL = entry ∓ $3.00.
 *   Mismatch (e.g. H1 red + M5 green) → no trade.
 *
 * 365d Step-2 result (as-built): ~38% TP-first, negative Avg R — not approved live.
 */
import type { AssetId, Candle } from "../types";

/** $3.00 = 30 points on XAUUSD. */
export const STRONG_CANDLE_TP_DISTANCE = 3;
export const STRONG_CANDLE_SL_DISTANCE = 3;

/** Body must cover at least this fraction of the full candle range. */
export const STRONG_BODY_RATIO = 0.85;
/** Each wick must be ≤ this fraction of range ("tiny" / none). */
export const STRONG_MAX_WICK_RATIO = 0.08;
/** Ignore micro noise candles below this range ($). */
export const STRONG_MIN_RANGE = 0.4;

export type StrongCandleDirection = "BUY" | "SELL";

export interface StrongCandleSignal {
  strategy: "strong_candle";
  direction: StrongCandleDirection;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  confidence: number;
  regime: string;
  dailyBias: string;
  reason: string[];
  time: number;
  /** Closed M5 bar time used for the signal (dedupe key). */
  m5BarTime: number;
}

export interface StrongCandleFrames {
  /** M5 */
  primary: Candle[];
  confirmation?: Candle[];
  /** H1 */
  bias: Candle[];
  daily?: Candle[];
}

export type CandleColor = "GREEN" | "RED" | "DOJI";

export function candleColor(c: Candle): CandleColor {
  if (c.close > c.open) return "GREEN";
  if (c.close < c.open) return "RED";
  return "DOJI";
}

export function isStrongCandle(c: Candle): boolean {
  const range = c.high - c.low;
  if (range < STRONG_MIN_RANGE) return false;
  const body = Math.abs(c.close - c.open);
  if (body <= 0) return false;
  if (body / range < STRONG_BODY_RATIO) return false;
  const mid = Math.max(c.open, c.close);
  const bot = Math.min(c.open, c.close);
  const upperWick = c.high - mid;
  const lowerWick = bot - c.low;
  if (upperWick / range > STRONG_MAX_WICK_RATIO) return false;
  if (lowerWick / range > STRONG_MAX_WICK_RATIO) return false;
  return true;
}

/** Prefer last fully closed bar when a live/forming bar is present. */
export function lastClosedBar(candles: Candle[]): Candle | null {
  if (!candles.length) return null;
  if (candles.length === 1) return candles[0];
  return candles[candles.length - 2];
}

export function applyStrongCandleLevels(
  direction: StrongCandleDirection,
  entry: number,
): { entry: number; sl: number; tp1: number; tp2: number } {
  if (direction === "BUY") {
    const tp1 = entry + STRONG_CANDLE_TP_DISTANCE;
    return {
      entry,
      sl: entry - STRONG_CANDLE_SL_DISTANCE,
      tp1,
      tp2: tp1,
    };
  }
  const tp1 = entry - STRONG_CANDLE_TP_DISTANCE;
  return {
    entry,
    sl: entry + STRONG_CANDLE_SL_DISTANCE,
    tp1,
    tp2: tp1,
  };
}

export function diagnoseStrongCandle(
  frames: StrongCandleFrames,
): { pass: boolean; waitReason: string; m5?: Candle; h1?: Candle } {
  const m5 = lastClosedBar(frames.primary ?? []);
  const h1 = lastClosedBar(frames.bias ?? []);
  if (!m5) return { pass: false, waitReason: "No M5 candles" };
  if (!h1) return { pass: false, waitReason: "No H1 candles" };

  const m5Color = candleColor(m5);
  if (m5Color === "DOJI") {
    return {
      pass: false,
      waitReason: "M5 last closed is doji — need green/red body",
      m5,
      h1,
    };
  }
  if (!isStrongCandle(m5)) {
    const range = m5.high - m5.low;
    const body = Math.abs(m5.close - m5.open);
    const bodyPct = range > 0 ? ((body / range) * 100).toFixed(0) : "0";
    return {
      pass: false,
      waitReason: `M5 not strong (body ${bodyPct}% of range · need ≥${(STRONG_BODY_RATIO * 100).toFixed(0)}% + tiny wicks)`,
      m5,
      h1,
    };
  }

  const h1Color = candleColor(h1);
  if (h1Color === "DOJI") {
    return {
      pass: false,
      waitReason: "H1 last closed is doji — skip",
      m5,
      h1,
    };
  }
  if (h1Color !== m5Color) {
    return {
      pass: false,
      waitReason: `Color mismatch — M5 ${m5Color} vs H1 ${h1Color} (need same)`,
      m5,
      h1,
    };
  }

  return { pass: true, waitReason: "", m5, h1 };
}

export function generateStrongCandleSignal(
  _assetId: AssetId,
  frames: StrongCandleFrames,
): StrongCandleSignal | null {
  const diag = diagnoseStrongCandle(frames);
  if (!diag.pass || !diag.m5 || !diag.h1) return null;

  const m5 = diag.m5;
  const h1 = diag.h1;
  const color = candleColor(m5);
  if (color === "DOJI") return null;

  const direction: StrongCandleDirection = color === "GREEN" ? "BUY" : "SELL";
  const entry = m5.close;
  const lv = applyStrongCandleLevels(direction, entry);
  const range = m5.high - m5.low;
  const body = Math.abs(m5.close - m5.open);
  const bodyPct = range > 0 ? (body / range) * 100 : 0;
  const conf = Math.min(95, Math.round(70 + bodyPct * 0.25));

  return {
    strategy: "strong_candle",
    direction,
    entry: lv.entry,
    sl: lv.sl,
    tp1: lv.tp1,
    tp2: lv.tp2,
    confidence: conf,
    regime: "STRONG_CANDLE",
    dailyBias: candleColor(h1),
    reason: [
      `Strong Candle · M5 ${color} marubozu-style · H1 ${candleColor(h1)} agree`,
      `TP $${STRONG_CANDLE_TP_DISTANCE} (30 pts) · SL $${STRONG_CANDLE_SL_DISTANCE}`,
      `M5 body ${(bodyPct).toFixed(0)}% of range · entry @ close ${entry.toFixed(2)}`,
      `H1 last closed ${candleColor(h1)} — same color gate pass`,
    ],
    time: m5.time,
    m5BarTime: m5.time,
  };
}
