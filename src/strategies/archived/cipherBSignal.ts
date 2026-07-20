// src/strategies/cipherBSignal.ts
// Standalone signal engine driven ONLY by the WaveTrend oscillator (open-source
// Cipher-B-clone). Isolated from signalEngine.ts and quickScalpEngine.ts — exists
// purely so its real-world accuracy can be measured independently against the
// other strategy tabs.

import { Candle, computeWaveTrend } from '../../indicators/waveTrend';

export type CipherBDirection = 'BUY' | 'SELL';

export interface CipherBSignal {
  strategy: 'cipher_b_clone';
  direction: CipherBDirection;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  reason: string[];
  time: number;
}

export interface CipherBInput {
  candles: Candle[]; // any single timeframe, e.g. M5
}

const MIN_CANDLES = 60;
const SWING_LOOKBACK = 10;
const RR_TP1 = 1.0;
const RR_TP2 = 2.0;

function validateInput(input: CipherBInput): void {
  if (!input || !Array.isArray(input.candles)) {
    throw new Error('CipherBSignal: candles array is required');
  }
  if (input.candles.length < MIN_CANDLES) {
    throw new Error(`CipherBSignal: need at least ${MIN_CANDLES} candles, got ${input.candles.length}`);
  }
}

/** Structural stop: most recent swing low/high over the lookback window. */
function recentSwingLevel(candles: Candle[], direction: CipherBDirection, lookback = SWING_LOOKBACK): number {
  const slice = candles.slice(-lookback);
  return direction === 'BUY' ? Math.min(...slice.map((c) => c.low)) : Math.max(...slice.map((c) => c.high));
}

export function generateCipherBSignal(input: CipherBInput): CipherBSignal | null {
  validateInput(input);

  const wt = computeWaveTrend(input.candles);
  const last = input.candles[input.candles.length - 1];
  const reason: string[] = [];

  let direction: CipherBDirection | null = null;
  if (wt.bullishCross && !wt.overbought) {
    direction = 'BUY';
    reason.push('WaveTrend bullish cross, not overbought');
    if (wt.bullishDivergence) reason.push('Bullish WT divergence present');
  } else if (wt.bearishCross && !wt.oversold) {
    direction = 'SELL';
    reason.push('WaveTrend bearish cross, not oversold');
    if (wt.bearishDivergence) reason.push('Bearish WT divergence present');
  }

  if (!direction) return null;

  const entry = last.close;
  const structureRisk = recentSwingLevel(input.candles, direction);
  const sl = structureRisk;
  const riskDistance = Math.abs(entry - sl);

  if (riskDistance <= 0 || !isFinite(riskDistance)) {
    return null; // degenerate structure — refuse rather than emit a broken signal
  }

  const tp1 = direction === 'BUY' ? entry + riskDistance * RR_TP1 : entry - riskDistance * RR_TP1;
  const tp2 = direction === 'BUY' ? entry + riskDistance * RR_TP2 : entry - riskDistance * RR_TP2;

  return { strategy: 'cipher_b_clone', direction, entry, sl, tp1, tp2, reason, time: last.time };
}
