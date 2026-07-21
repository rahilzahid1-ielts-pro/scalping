// src/strategies/fractalSignal.ts
// Standalone signal engine using the classic Bill Williams Fractal indicator
// (public/well-documented technical analysis pattern — NOT a proprietary tool).
// A fractal high/low is a 5-candle pattern where the middle candle's high (or low)
// is the most extreme in the window. Signal = price breaking out beyond the most
// recent confirmed fractal in the breakout direction.
// Isolated from every other strategy file in this project.

import { Candle } from '../../indicators/waveTrend';

export type FractalDirection = 'BUY' | 'SELL';

export interface FractalSignal {
  strategy: 'fractal';
  direction: FractalDirection;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  reason: string[];
  time: number;
}

export interface FractalInput {
  candles: Candle[];
}

interface FractalPoint {
  index: number;
  price: number;
  type: 'HIGH' | 'LOW';
}

const MIN_CANDLES = 30;
const FRACTAL_WINDOW = 2; // classic Bill Williams: 2 candles either side
const SEARCH_LOOKBACK = 30;
const RR_TP1 = 1.0;
const RR_TP2 = 2.0;

function validateInput(input: FractalInput): void {
  if (!input || !Array.isArray(input.candles)) {
    throw new Error('FractalSignal: candles array is required');
  }
  if (input.candles.length < MIN_CANDLES) {
    throw new Error(`FractalSignal: need at least ${MIN_CANDLES} candles, got ${input.candles.length}`);
  }
}

/** Finds the most recent CONFIRMED fractal high and low (confirmed = has 2 candles closed after it). */
function findRecentFractals(candles: Candle[]): { high: FractalPoint | null; low: FractalPoint | null } {
  const n = candles.length;
  const start = Math.max(FRACTAL_WINDOW, n - SEARCH_LOOKBACK);
  const lastConfirmableIndex = n - 1 - FRACTAL_WINDOW; // need FRACTAL_WINDOW candles after it to confirm

  let high: FractalPoint | null = null;
  let low: FractalPoint | null = null;

  for (let i = start; i <= lastConfirmableIndex; i++) {
    const windowSlice = candles.slice(i - FRACTAL_WINDOW, i + FRACTAL_WINDOW + 1);
    const isHigh = candles[i].high === Math.max(...windowSlice.map((c) => c.high));
    const isLow = candles[i].low === Math.min(...windowSlice.map((c) => c.low));
    if (isHigh) high = { index: i, price: candles[i].high, type: 'HIGH' };
    if (isLow) low = { index: i, price: candles[i].low, type: 'LOW' };
  }

  return { high, low };
}

export function generateFractalSignal(input: FractalInput): FractalSignal | null {
  validateInput(input);

  const { high, low } = findRecentFractals(input.candles);
  const last = input.candles[input.candles.length - 1];
  const prev = input.candles[input.candles.length - 2];

  if (!high && !low) return null;

  let direction: FractalDirection | null = null;
  const reason: string[] = [];

  // Breakout above the most recent confirmed fractal high (fresh cross this bar)
  if (high && prev.close <= high.price && last.close > high.price) {
    direction = 'BUY';
    reason.push(`Breakout above fractal high ${high.price.toFixed(2)} (bar -${input.candles.length - 1 - high.index})`);
  }
  // Breakout below the most recent confirmed fractal low (fresh cross this bar)
  else if (low && prev.close >= low.price && last.close < low.price) {
    direction = 'SELL';
    reason.push(`Breakout below fractal low ${low.price.toFixed(2)} (bar -${input.candles.length - 1 - low.index})`);
  }

  if (!direction) return null;

  const entry = last.close;
  const sl = direction === 'BUY' ? (low ? low.price : entry - Math.abs(entry - (high?.price ?? entry)))
                                  : (high ? high.price : entry + Math.abs(entry - (low?.price ?? entry)));
  const riskDistance = Math.abs(entry - sl);

  if (riskDistance <= 0 || !isFinite(riskDistance)) return null;

  const tp1 = direction === 'BUY' ? entry + riskDistance * RR_TP1 : entry - riskDistance * RR_TP1;
  const tp2 = direction === 'BUY' ? entry + riskDistance * RR_TP2 : entry - riskDistance * RR_TP2;

  return { strategy: 'fractal', direction, entry, sl, tp1, tp2, reason, time: last.time };
}
