/**
 * Intra30 — strong candle (no / tiny wick, big body) → trade opens on the NEXT
 * M5 candle in that color's direction.
 *
 *   Green strong → BUY · Red strong → SELL
 *   TP1 = entry ± $3.00 (30 points) — bank
 *   TP2 = entry ± $6.00 (60 points) — runner until TP2 price OR a weak candle
 *   SL  = entry ∓ $3.00
 *
 * Pattern rule: signal on the FIRST strong candle of a run only.
 * Consecutive same-color strong candles do not re-fire; after a break
 * (weak / opposite / non-strong), the next first strong starts a new pattern.
 *
 * Multiple patterns can fire while earlier trades are still OPEN.
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

/**
 * True when `idx` is a strong candle that starts a new pattern:
 * previous bar is not a strong candle of the same color.
 */
export function isFirstStrongOfPattern(
  candles: Candle[],
  idx: number,
): boolean {
  if (idx < 0 || idx >= candles.length) return false;
  const c = candles[idx];
  if (!isStrongCandle(c)) return false;
  const color = candleColor(c);
  if (color === "DOJI") return false;
  if (idx === 0) return true;
  const prev = candles[idx - 1];
  if (isStrongCandle(prev) && candleColor(prev) === color) return false;
  return true;
}

/**
 * First-of-pattern strong → next bar entry.
 * Looks only at the live tip window so we fire as soon as that next candle opens.
 */
export function findStrongThenNext(
  candles: Candle[],
): { strong: Candle; entryBar: Candle } | null {
  if (candles.length < 2) return null;

  const n = candles.length;
  // […, firstStrong, nextForming]
  if (isFirstStrongOfPattern(candles, n - 2)) {
    return { strong: candles[n - 2], entryBar: candles[n - 1] };
  }
  // […, firstStrong, entryClosed, tip?]
  if (n >= 3 && isFirstStrongOfPattern(candles, n - 3)) {
    return { strong: candles[n - 3], entryBar: candles[n - 2] };
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
      waitReason: `Intra30: pehli strong M5 (body≥${(STRONG_BODY_RATIO * 100).toFixed(0)}%, wick≤${(STRONG_MAX_WICK_RATIO * 100).toFixed(0)}%) + next candle · consecutive strong pe dubara nahi`,
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
      `Intra30 · pehli strong ${color} M5 → next candle ${direction} (pattern start)`,
      `Entry @ next open ${entry.toFixed(2)} · TP1 $${INTRA30_TP_DISTANCE} (30pts) · TP2 $${INTRA30_TP2_DISTANCE} · SL $${INTRA30_SL_DISTANCE}`,
      `Nayi pehli strong (pattern break ke baad) = naya signal · body ${bodyPct.toFixed(0)}% of range`,
    ],
  };
}
