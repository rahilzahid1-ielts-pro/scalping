/**
 * Attach session / trend / vol context to LearnRows from M5 candles.
 */
import type { Candle } from "../types";
import { karachiHour } from "./features";
import type {
  LearnRow,
  LearnSession,
  LearnTrend,
  LearnVol,
} from "./types";

const SMA_LEN = 50;
const ATR_LEN = 14;
/** ~5 trading days of M5 bars for ATR percentile window. */
const ATR_LOOKBACK = 5 * 24 * 12; // 1440
const FLAT_BAND = 0.0005; // ±0.05%

export function sessionOf(ms: number): LearnSession {
  const hour = karachiHour(ms);
  if (hour >= 4 && hour < 11) return "asia_am";
  if (hour >= 11 && hour < 16) return "mid";
  if (hour >= 16 && hour < 21) return "eve";
  return "night";
}

function trueRange(c: Candle, prevClose: number): number {
  return Math.max(
    c.high - c.low,
    Math.abs(c.high - prevClose),
    Math.abs(c.low - prevClose),
  );
}

/** Binary search: largest i with candles[i].time <= t. */
function indexAtOrBefore(candles: Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function sma(candles: Candle[], end: number, len: number): number | null {
  if (end < len - 1) return null;
  let s = 0;
  for (let i = end - len + 1; i <= end; i++) s += candles[i].close;
  return s / len;
}

function atrAt(candles: Candle[], end: number, len: number): number | null {
  if (end < len) return null;
  let s = 0;
  for (let i = end - len + 1; i <= end; i++) {
    s += trueRange(candles[i], candles[i - 1].close);
  }
  return s / len;
}

function volBucket(
  candles: Candle[],
  end: number,
  atr: number,
): LearnVol {
  const start = Math.max(ATR_LEN, end - ATR_LOOKBACK);
  const vals: number[] = [];
  for (let i = start; i <= end; i++) {
    const a = atrAt(candles, i, ATR_LEN);
    if (a != null) vals.push(a);
  }
  if (vals.length < 20) return "mid";
  vals.sort((a, b) => a - b);
  const rank = vals.findIndex((v) => v >= atr);
  const pct = rank < 0 ? 1 : rank / (vals.length - 1);
  if (pct <= 0.33) return "low";
  if (pct >= 0.67) return "high";
  return "mid";
}

function trendAt(candles: Candle[], end: number): LearnTrend {
  const ma = sma(candles, end, SMA_LEN);
  if (ma == null || ma <= 0) return "flat";
  const close = candles[end].close;
  const diff = (close - ma) / ma;
  if (diff > FLAT_BAND) return "up";
  if (diff < -FLAT_BAND) return "down";
  return "flat";
}

export function marketContextAt(
  candles: Candle[],
  atMs: number,
): { session: LearnSession; trend: LearnTrend; vol: LearnVol } {
  const session = sessionOf(atMs);
  const i = indexAtOrBefore(candles, atMs);
  if (i < SMA_LEN) {
    return { session, trend: "flat", vol: "mid" };
  }
  const atr = atrAt(candles, i, ATR_LEN);
  return {
    session,
    trend: trendAt(candles, i),
    vol: atr != null ? volBucket(candles, i, atr) : "mid",
  };
}

/** Mutates rows in place with session/trend/vol. */
export function attachMarketContext(
  rows: LearnRow[],
  candles: Candle[],
): LearnRow[] {
  if (candles.length === 0) return rows;
  for (const r of rows) {
    const ctx = marketContextAt(candles, r.executedAt);
    r.session = ctx.session;
    r.trend = ctx.trend;
    r.vol = ctx.vol;
  }
  return rows;
}
