/**
 * Intra30 — strong candle (no / tiny wick, big body) → trade opens on the NEXT
 * M5 candle in that color's direction.
 *
 *   Green strong → BUY · Red strong → SELL
 *   TP1 = entry ± $3.00 (30 points) — bank
 *   TP2 = entry ± $6.00 (60 points) — runner until TP2 price OR a weak candle
 *   SL  = entry ∓ $3.00
 *
 * No SMC / H1 gates — formula is candle-structure only.
 */
import type { AssetId, Candle } from "../types";
import {
  STRONG_BODY_RATIO,
  STRONG_MAX_WICK_RATIO,
  STRONG_MIN_RANGE,
  candleColor,
  isStrongCandle,
  type CandleColor,
} from "./strongCandleEngine";

export const INTRA30_TP_DISTANCE = 3;
export const INTRA30_SL_DISTANCE = 3;
export const INTRA30_TP2_DISTANCE = 6;

export type Intra30Direction = "BUY" | "SELL";

export interface Intra30Signal {
  strategy: "intra30";
  direction: Intra30Direction;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  confidence: number;
  regime: string;
  dailyBias: string;
  reason: string[];
  time: number;
  /** Strong candle bar time — dedupe key. */
  strongBarTime: number;
}

export interface Intra30Frames {
  primary: Candle[];
  confirmation?: Candle[];
  bias?: Candle[];
  daily?: Candle[];
}

export function applyIntra30Levels(
  direction: Intra30Direction,
  entry: number,
): { entry: number; sl: number; tp1: number; tp2: number } {
  if (direction === "BUY") {
    return {
      entry,
      sl: entry - INTRA30_SL_DISTANCE,
      tp1: entry + INTRA30_TP_DISTANCE,
      tp2: entry + INTRA30_TP2_DISTANCE,
    };
  }
  return {
    entry,
    sl: entry + INTRA30_SL_DISTANCE,
    tp1: entry - INTRA30_TP_DISTANCE,
    tp2: entry - INTRA30_TP2_DISTANCE,
  };
}

/** Weak = not a strong marubozu (small body and/or fat wicks / noise). */
export function isWeakCandle(c: Candle): boolean {
  const range = c.high - c.low;
  if (range < STRONG_MIN_RANGE) return true;
  const body = Math.abs(c.close - c.open);
  if (body <= 0) return true;
  if (body / range < 0.5) return true;
  const mid = Math.max(c.open, c.close);
  const bot = Math.min(c.open, c.close);
  const upperWick = c.high - mid;
  const lowerWick = bot - c.low;
  if (upperWick / range > 0.25) return true;
  if (lowerWick / range > 0.25) return true;
  return false;
}

export function findStrongThenNext(
  candles: Candle[],
): { strong: Candle; entryBar: Candle } | null {
  if (candles.length < 2) return null;

  // Tip may be forming: […, strong, nextForming]
  const a = candles[candles.length - 2];
  const b = candles[candles.length - 1];
  if (isStrongCandle(a) && candleColor(a) !== "DOJI") {
    return { strong: a, entryBar: b };
  }

  // Next bar already closed: […, strong, entryClosed, tip?]
  if (candles.length >= 3) {
    const s = candles[candles.length - 3];
    if (isStrongCandle(s) && candleColor(s) !== "DOJI") {
      return { strong: s, entryBar: a };
    }
  }
  return null;
}

export function diagnoseIntra30(
  frames: Intra30Frames,
): { pass: boolean; waitReason: string } {
  const setup = findStrongThenNext(frames.primary ?? []);
  if (!setup) {
    return {
      pass: false,
      waitReason: `Intra30: strong M5 (body≥${(STRONG_BODY_RATIO * 100).toFixed(0)}%, wick≤${(STRONG_MAX_WICK_RATIO * 100).toFixed(0)}%) + next candle chahiye`,
    };
  }
  return { pass: true, waitReason: "" };
}

export function generateIntra30Signal(
  _assetId: AssetId,
  frames: Intra30Frames,
): Intra30Signal | null {
  const setup = findStrongThenNext(frames.primary ?? []);
  if (!setup) return null;

  const { strong, entryBar } = setup;
  const color: CandleColor = candleColor(strong);
  if (color === "DOJI") return null;

  const direction: Intra30Direction = color === "GREEN" ? "BUY" : "SELL";
  const entry = entryBar.open;
  const lv = applyIntra30Levels(direction, entry);
  const range = strong.high - strong.low;
  const body = Math.abs(strong.close - strong.open);
  const bodyPct = range > 0 ? (body / range) * 100 : 0;
  const conf = Math.min(95, Math.round(72 + bodyPct * 0.2));

  return {
    strategy: "intra30",
    direction,
    entry: lv.entry,
    sl: lv.sl,
    tp1: lv.tp1,
    tp2: lv.tp2,
    confidence: conf,
    regime: "STRONG_CANDLE",
    dailyBias: color,
    strongBarTime: strong.time,
    time: entryBar.time || strong.time,
    reason: [
      `Intra30 · strong ${color} M5 (no/tiny wick) → next candle ${direction}`,
      `Entry @ next open ${entry.toFixed(2)} · TP1 $${INTRA30_TP_DISTANCE} (30pts) · TP2 $${INTRA30_TP2_DISTANCE} · SL $${INTRA30_SL_DISTANCE}`,
      `TP2 runner until weak candle or TP2 price · body ${bodyPct.toFixed(0)}% of range`,
    ],
  };
}
