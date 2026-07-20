// src/indicators/waveTrend.ts
// Open-source WaveTrend + Money Flow oscillator (public LazyBear/VuManChu formula).
// NOTE: This is NOT Market Cipher B. MCB is a paid closed-source indicator with an
// undisclosed exact formula. This is the publicly documented WaveTrend algorithm that
// community "Cipher B clone" scripts are built on. Do not market this as MCB.

import type { Candle } from "../types";

export type { Candle };

export interface WaveTrendPoint {
  time: number;
  wt1: number;
  wt2: number;
  mfi: number; // -1..+1 money-flow proxy
}

export interface WaveTrendResult {
  points: WaveTrendPoint[];
  bullishCross: boolean;
  bearishCross: boolean;
  overbought: boolean;
  oversold: boolean;
  bullishDivergence: boolean;
  bearishDivergence: boolean;
}

const CHANNEL_LEN = 10;
const AVERAGE_LEN = 21;
const MA_LEN = 4;
const OB_LEVEL = 60;
const OS_LEVEL = -60;
const DIVERGENCE_LOOKBACK = 20;
const MIN_CANDLES = AVERAGE_LEN + MA_LEN + 5;

function ema(values: number[], period: number): number[] {
  if (period <= 0) throw new Error(`ema: invalid period ${period}`);
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function sma(values: number[], period: number): number[] {
  if (period <= 0) throw new Error(`sma: invalid period ${period}`);
  const out: number[] = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Money-flow proxy. Forex feeds usually have no real trade volume, only tick count.
 * If volume is present and non-zero we use a volume-weighted flow; otherwise we fall
 * back to a typical-price RSI rescaled to -1..+1, the standard substitute used by
 * public Cipher-B-clone scripts when volume is unreliable.
 */
function computeMoneyFlowProxy(candles: Candle[], period = 60): number[] {
  const hasVolume = candles.some((c) => (c.volume ?? 0) > 0);
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);

  if (hasVolume) {
    const raw: number[] = [0];
    for (let i = 1; i < candles.length; i++) {
      const flow = tp[i] * (candles[i].volume ?? 0);
      raw.push(tp[i] >= tp[i - 1] ? flow : -flow);
    }
    const smoothed = sma(raw, period);
    const maxAbs = Math.max(1e-9, ...smoothed.map((v) => Math.abs(isNaN(v) ? 0 : v)));
    return smoothed.map((v) => (isNaN(v) ? 0 : v) / maxAbs);
  }

  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < tp.length; i++) {
    const diff = tp[i] - tp[i - 1];
    gains.push(Math.max(0, diff));
    losses.push(Math.max(0, -diff));
  }
  const avgGain = sma(gains, period);
  const avgLoss = sma(losses, period);
  return avgGain.map((g, i) => {
    const l = avgLoss[i];
    if (isNaN(g) || isNaN(l) || l === 0) return 0;
    const rs = g / l;
    const rsi = 100 - 100 / (1 + rs);
    return (rsi - 50) / 50;
  });
}

function detectDivergence(
  candles: Candle[],
  points: WaveTrendPoint[],
): { bullishDivergence: boolean; bearishDivergence: boolean } {
  const n = points.length;
  const lookback = Math.min(DIVERGENCE_LOOKBACK, n - 1);
  if (lookback < 5) return { bullishDivergence: false, bearishDivergence: false };

  const slice = candles.slice(n - lookback);
  const wtSlice = points.slice(n - lookback);

  let lowIdx = 0;
  let highIdx = 0;
  for (let i = 1; i < slice.length - 1; i++) {
    if (slice[i].low < slice[lowIdx].low) lowIdx = i;
    if (slice[i].high > slice[highIdx].high) highIdx = i;
  }
  const lastIdx = slice.length - 1;

  const bullishDivergence =
    lastIdx !== lowIdx &&
    slice[lastIdx].low < slice[lowIdx].low &&
    wtSlice[lastIdx].wt1 > wtSlice[lowIdx].wt1 &&
    wtSlice[lastIdx].wt1 < OS_LEVEL + 20;

  const bearishDivergence =
    lastIdx !== highIdx &&
    slice[lastIdx].high > slice[highIdx].high &&
    wtSlice[lastIdx].wt1 < wtSlice[highIdx].wt1 &&
    wtSlice[lastIdx].wt1 > OB_LEVEL - 20;

  return { bullishDivergence, bearishDivergence };
}

export function computeWaveTrend(candles: Candle[]): WaveTrendResult {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) {
    throw new Error(
      `computeWaveTrend: need at least ${MIN_CANDLES} candles, got ${candles?.length ?? 0}`,
    );
  }
  for (const c of candles) {
    if ([c.open, c.high, c.low, c.close].some((v) => typeof v !== "number" || !isFinite(v))) {
      throw new Error(`computeWaveTrend: malformed candle at time=${c.time}`);
    }
  }

  const ap = candles.map((c) => (c.high + c.low + c.close) / 3);
  const esa = ema(ap, CHANNEL_LEN);
  const absDiff = ap.map((v, i) => Math.abs(v - esa[i]));
  const d = ema(absDiff, CHANNEL_LEN).map((v) => Math.max(v, 1e-9));
  const ci = ap.map((v, i) => (v - esa[i]) / (0.015 * d[i]));
  const wt1 = ema(ci, AVERAGE_LEN);
  const wt2 = sma(wt1, MA_LEN);
  const mfi = computeMoneyFlowProxy(candles);

  const points: WaveTrendPoint[] = candles.map((c, i) => ({
    time: c.time,
    wt1: wt1[i],
    wt2: isNaN(wt2[i]) ? wt1[i] : wt2[i],
    mfi: mfi[i] ?? 0,
  }));

  const n = points.length;
  const last = points[n - 1];
  const prev = points[n - 2];

  const bullishCross = prev.wt1 <= prev.wt2 && last.wt1 > last.wt2;
  const bearishCross = prev.wt1 >= prev.wt2 && last.wt1 < last.wt2;
  const overbought = last.wt1 > OB_LEVEL;
  const oversold = last.wt1 < OS_LEVEL;

  const { bullishDivergence, bearishDivergence } = detectDivergence(candles, points);

  return {
    points,
    bullishCross,
    bearishCross,
    overbought,
    oversold,
    bullishDivergence,
    bearishDivergence,
  };
}
