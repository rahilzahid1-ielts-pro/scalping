/**
 * Intra30 best pack (A/B winner near 58%):
 *   pehli strict strong M5 (body≥90%, wick≤5%) → next open
 *   H1 + Daily same color · 2h chase block · SL $5 / TP1 $3 / TP2 $6
 *   Live: 1 OPEN max · post-resolve cooldown · opposite fade block
 *
 * Worker default ON on Railway (ENABLE_INTRA30_WORKER=0 to disable).
 */
import type { AssetId, Candle } from "../types";
import {
  STRONG_MIN_RANGE,
  candleColor,
  lastClosedBar,
  type CandleColor,
} from "./strongCandleEngine";
import { isExtendedChase } from "../utils/entryFilters";

/** Stricter than shared Strong Candle measurement thresholds. */
export const INTRA30_BODY_RATIO = 0.9;
export const INTRA30_MAX_WICK_RATIO = 0.05;

export const INTRA30_TP_DISTANCE = 3;
export const INTRA30_SL_DISTANCE = 5;
export const INTRA30_TP2_DISTANCE = 6;

export const INTRA30_POST_RESOLVE_COOLDOWN_MS = 25 * 60 * 1000;
export const INTRA30_OPPOSITE_BLOCK_MS = 30 * 60 * 1000;
export const INTRA30_POST_RESOLVE_COOLDOWN_BARS = 5;
export const INTRA30_OPPOSITE_BLOCK_BARS = 6;

/** Badge gate (Intra30-only): slightly softer than Pro's 58%. */
export const INTRA30_VALIDATE_MIN_WR = 55;

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

export function isIntra30StrongCandle(c: Candle): boolean {
  const range = c.high - c.low;
  if (range < STRONG_MIN_RANGE) return false;
  const body = Math.abs(c.close - c.open);
  if (body <= 0) return false;
  if (body / range < INTRA30_BODY_RATIO) return false;
  const mid = Math.max(c.open, c.close);
  const bot = Math.min(c.open, c.close);
  if ((c.high - mid) / range > INTRA30_MAX_WICK_RATIO) return false;
  if ((bot - c.low) / range > INTRA30_MAX_WICK_RATIO) return false;
  return true;
}

export function isWeakCandle(c: Candle): boolean {
  const range = c.high - c.low;
  if (range < STRONG_MIN_RANGE) return true;
  const body = Math.abs(c.close - c.open);
  if (body <= 0) return true;
  if (body / range < 0.5) return true;
  const mid = Math.max(c.open, c.close);
  const bot = Math.min(c.open, c.close);
  if ((c.high - mid) / range > 0.25) return true;
  if ((bot - c.low) / range > 0.25) return true;
  return false;
}

export function isFirstStrongOfPattern(
  candles: Candle[],
  idx: number,
): boolean {
  if (idx < 0 || idx >= candles.length) return false;
  const c = candles[idx];
  if (!isIntra30StrongCandle(c)) return false;
  const color = candleColor(c);
  if (color === "DOJI") return false;
  if (idx === 0) return true;
  const prev = candles[idx - 1];
  if (isIntra30StrongCandle(prev) && candleColor(prev) === color) return false;
  return true;
}

export function findStrongThenNext(
  candles: Candle[],
): { strong: Candle; entryBar: Candle } | null {
  if (candles.length < 2) return null;
  const n = candles.length;
  if (isFirstStrongOfPattern(candles, n - 2)) {
    return { strong: candles[n - 2], entryBar: candles[n - 1] };
  }
  if (n >= 3 && isFirstStrongOfPattern(candles, n - 3)) {
    return { strong: candles[n - 3], entryBar: candles[n - 2] };
  }
  return null;
}

function htfAgrees(
  frames: Intra30Frames,
  m5Color: CandleColor,
): string | null {
  const h1 = lastClosedBar(frames.bias ?? []);
  if (!h1) return "Intra30: H1 candle chahiye";
  const h1Color = candleColor(h1);
  if (h1Color === "DOJI") return "Intra30: H1 doji — skip";
  if (h1Color !== m5Color) {
    return `Intra30: H1 ${h1Color} vs M5 ${m5Color} — same color chahiye`;
  }
  const dailyBars = frames.daily ?? [];
  // Forming daily (last bar) tracks *today's* color. lastClosed stayed on yesterday
  // and blocked all M5 sells while Daily GREEN — main reason live went quiet.
  const daily =
    dailyBars.length > 0 ? dailyBars[dailyBars.length - 1] : null;
  if (!daily) return "Intra30: Daily candle chahiye";
  const dColor = candleColor(daily);
  if (dColor === "DOJI") return "Intra30: Daily doji — skip";
  if (dColor !== m5Color) {
    return `Intra30: Daily ${dColor} vs M5 ${m5Color} — same color chahiye`;
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
      waitReason: `Intra30: pehli strict M5 (body≥${(INTRA30_BODY_RATIO * 100).toFixed(0)}%, wick≤${(INTRA30_MAX_WICK_RATIO * 100).toFixed(0)}%) + next · H1+Daily same · no chase`,
    };
  }
  const color = candleColor(setup.strong);
  if (color === "DOJI") {
    return { pass: false, waitReason: "Intra30: strong doji — skip" };
  }
  const htf = htfAgrees(frames, color);
  if (htf) return { pass: false, waitReason: htf };
  const direction: Intra30Direction = color === "GREEN" ? "BUY" : "SELL";
  if (isExtendedChase(direction, frames.primary ?? [])) {
    return {
      pass: false,
      waitReason:
        direction === "BUY"
          ? "Intra30: chase block — near 2h high"
          : "Intra30: chase block — near 2h low",
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
  if (htfAgrees(frames, color)) return null;

  const direction: Intra30Direction = color === "GREEN" ? "BUY" : "SELL";
  if (isExtendedChase(direction, frames.primary ?? [])) return null;

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
      `Intra30 · strict ${color} M5 + H1/Daily ${color} → next ${direction}`,
      `Entry @ ${entry.toFixed(2)} · TP1 $${INTRA30_TP_DISTANCE} · TP2 $${INTRA30_TP2_DISTANCE} · SL $${INTRA30_SL_DISTANCE}`,
      `1-open · no 2h chase · cooldown after resolve · body ${bodyPct.toFixed(0)}%`,
    ],
  };
}
