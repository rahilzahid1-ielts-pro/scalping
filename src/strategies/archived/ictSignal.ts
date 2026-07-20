// src/strategies/ictSignal.ts
// Standalone ICT-concepts signal engine: only fires inside defined killzones, on a
// liquidity sweep followed by an FVG entry (a simplified Optimal-Trade-Entry model).
// Isolated from signalEngine.ts, quickScalpEngine.ts and cipherBSignal.ts so its
// real-world accuracy can be measured independently.
//
// NOTE ON OVERLAP: this project's main strategy is already SMC-based, and ICT is
// largely the same underlying concept set (order blocks, FVGs, liquidity, market
// structure) under a different name/branding. This engine is kept deliberately
// distinct by gating on killzone time windows, which the main strategy does not use.

import { Candle } from '../../indicators/waveTrend';

export type IctDirection = 'BUY' | 'SELL';

export interface IctSignal {
  strategy: 'ict';
  direction: IctDirection;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  reason: string[];
  killzone: 'LONDON' | 'NEW_YORK';
  time: number;
}

export interface IctInput {
  candles: Candle[]; // single timeframe, e.g. M5, with .time in unix seconds (UTC)
}

interface FVG {
  index: number;
  direction: IctDirection;
  top: number;
  bottom: number;
}

const MIN_CANDLES = 60;
const SWEEP_LOOKBACK = 20;
const FVG_LOOKBACK = 20;
const SL_BUFFER_POINTS = 0.5;
const RR_TP1 = 1.0;
const RR_TP2 = 2.0;

// Killzones in UTC hours [start, end). Adjust if your broker feed uses a different
// server-time offset — these assume candle.time is true UTC.
const LONDON_KZ: [number, number] = [7, 10];
const NY_KZ: [number, number] = [12, 15];

function validateInput(input: IctInput): void {
  if (!input || !Array.isArray(input.candles)) {
    throw new Error('IctSignal: candles array is required');
  }
  if (input.candles.length < MIN_CANDLES) {
    throw new Error(`IctSignal: need at least ${MIN_CANDLES} candles, got ${input.candles.length}`);
  }
}

function getActiveKillzone(unixSeconds: number): 'LONDON' | 'NEW_YORK' | null {
  const hour = new Date(unixSeconds * 1000).getUTCHours();
  if (hour >= LONDON_KZ[0] && hour < LONDON_KZ[1]) return 'LONDON';
  if (hour >= NY_KZ[0] && hour < NY_KZ[1]) return 'NEW_YORK';
  return null;
}

/** Detects a liquidity sweep: a wick beyond the recent swing high/low that closes back inside range. */
function detectLiquiditySweep(candles: Candle[], lookback = SWEEP_LOOKBACK): IctDirection | null {
  const n = candles.length;
  if (n < lookback + 1) return null;

  const priorSlice = candles.slice(n - lookback - 1, n - 1);
  const last = candles[n - 1];
  const priorHigh = Math.max(...priorSlice.map((c) => c.high));
  const priorLow = Math.min(...priorSlice.map((c) => c.low));

  // Swept the high (wick above prior range, closed back below it) -> bearish signal
  if (last.high > priorHigh && last.close < priorHigh) return 'SELL';
  // Swept the low (wick below prior range, closed back above it) -> bullish signal
  if (last.low < priorLow && last.close > priorLow) return 'BUY';
  return null;
}

/** Self-contained FVG detector. Cursor: replace with exported findFVG from smartMoney.ts. */
function findRecentFVG(candles: Candle[], lookback = FVG_LOOKBACK): FVG | null {
  const n = candles.length;
  const start = Math.max(2, n - lookback);
  let found: FVG | null = null;

  for (let i = start; i < n; i++) {
    const a = candles[i - 2];
    const c = candles[i];
    if (c.low > a.high) found = { index: i, direction: 'BUY', top: c.low, bottom: a.high };
    if (c.high < a.low) found = { index: i, direction: 'SELL', top: a.low, bottom: c.high };
  }
  return found;
}

function priceReturnedToFVG(candles: Candle[], fvg: FVG): boolean {
  const last = candles[candles.length - 1];
  return last.close <= fvg.top && last.close >= fvg.bottom;
}

export function generateIctSignal(input: IctInput): IctSignal | null {
  validateInput(input);

  const last = input.candles[input.candles.length - 1];
  const killzone = getActiveKillzone(last.time);
  if (!killzone) return null; // outside defined killzones — no ICT signal by design

  const sweepDirection = detectLiquiditySweep(input.candles);
  if (!sweepDirection) return null;

  const reason: string[] = [
    `Active killzone: ${killzone}`,
    `Liquidity sweep detected, bias=${sweepDirection}`,
  ];

  const fvg = findRecentFVG(input.candles);
  if (!fvg || fvg.direction !== sweepDirection) return null;
  if (!priceReturnedToFVG(input.candles, fvg)) return null;
  reason.push(`FVG (${fvg.direction}) mitigated at ${fvg.bottom.toFixed(2)}-${fvg.top.toFixed(2)} (OTE entry)`);

  const entry = last.close;
  const structureRisk = sweepDirection === 'BUY' ? fvg.bottom : fvg.top;
  const sl = sweepDirection === 'BUY' ? structureRisk - SL_BUFFER_POINTS : structureRisk + SL_BUFFER_POINTS;
  const riskDistance = Math.abs(entry - sl);

  if (riskDistance <= 0 || !isFinite(riskDistance)) return null;

  const tp1 = sweepDirection === 'BUY' ? entry + riskDistance * RR_TP1 : entry - riskDistance * RR_TP1;
  const tp2 = sweepDirection === 'BUY' ? entry + riskDistance * RR_TP2 : entry - riskDistance * RR_TP2;

  return {
    strategy: 'ict',
    direction: sweepDirection,
    entry,
    sl,
    tp1,
    tp2,
    reason,
    killzone,
    time: last.time,
  };
}
