import type { Candle, TradeMode } from "../types";
import { aggregateCandles } from "../services/marketData";

const M5_MS = 5 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;
const H1_MS = 60 * 60 * 1000;
const H4_MS = 4 * 60 * 60 * 1000;
const D1_MS = 24 * 60 * 60 * 1000;

export interface PrefetchedHtfs {
  m15: Candle[];
  h1: Candle[];
  h4: Candle[];
  daily: Candle[];
}

export interface FrameBundle {
  primary: Candle[];
  confirmation: Candle[];
  bias: Candle[];
  daily: Candle[];
  asOfCloseMs: number;
}

/**
 * Precompute HTF from the full M5 series once.
 * Look-ahead is still prevented at use-time by onlyFullyClosed(asOfCloseMs):
 * completed buckets are identical whether aggregated from a prefix or the full
 * series; incomplete buckets are dropped.
 */
export function precomputeHtfs(m5: Candle[]): PrefetchedHtfs {
  return {
    m15: aggregateCandles(m5, 0.25),
    h1: aggregateCandles(m5, 1),
    h4: aggregateCandles(m5, 4),
    daily: aggregateCandles(m5, 24),
  };
}

/** Keep only HTF bars that have fully closed by `asOfCloseMs` (no partial candle). */
export function onlyFullyClosed(
  bars: Candle[],
  periodMs: number,
  asOfCloseMs: number,
): Candle[] {
  // binary search last index with time + periodMs <= asOfCloseMs
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time + periodMs <= asOfCloseMs) lo = mid + 1;
    else hi = mid;
  }
  return bars.slice(0, lo);
}

export function framesAtIndex(
  m5: Candle[],
  i: number,
  mode: TradeMode,
  htfs: PrefetchedHtfs,
  primaryLookback = 400,
): FrameBundle | null {
  if (i < 0 || i >= m5.length) return null;
  const periodMs =
    i + 1 < m5.length ? m5[i + 1].time - m5[i].time : M5_MS;
  const asOfCloseMs = m5[i].time + periodMs;

  const m15 = onlyFullyClosed(htfs.m15, M15_MS, asOfCloseMs);
  const h1 = onlyFullyClosed(htfs.h1, H1_MS, asOfCloseMs);
  const h4 = onlyFullyClosed(htfs.h4, H4_MS, asOfCloseMs);
  const daily = onlyFullyClosed(htfs.daily, D1_MS, asOfCloseMs);
  const primaryPrefix = m5.slice(0, i + 1);

  if (mode === "scalping") {
    if (primaryPrefix.length < 220 || m15.length < 80 || h1.length < 50 || daily.length < 40) {
      return null;
    }
    return {
      primary: primaryPrefix.slice(-primaryLookback),
      confirmation: m15.slice(-primaryLookback),
      bias: h1.slice(-primaryLookback),
      daily: daily.slice(-300),
      asOfCloseMs,
    };
  }

  if (m15.length < 220 || h1.length < 80 || h4.length < 50 || daily.length < 40) {
    return null;
  }
  return {
    primary: m15.slice(-primaryLookback),
    confirmation: h1.slice(-primaryLookback),
    bias: h4.slice(-primaryLookback),
    daily: daily.slice(-300),
    asOfCloseMs,
  };
}

/** True when this M5 index is the last bar of a completed 15m bucket. */
export function isClosedFifteenEnd(m5: Candle[], i: number): boolean {
  if (i < 0 || i >= m5.length) return false;
  const t = m5[i].time;
  const bucket = Math.floor(t / M15_MS) * M15_MS;
  const next = i + 1 < m5.length ? m5[i + 1].time : t + M5_MS;
  return Math.floor(next / M15_MS) * M15_MS !== bucket || i === m5.length - 1;
}
