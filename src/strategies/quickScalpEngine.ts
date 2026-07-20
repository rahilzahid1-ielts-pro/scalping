// src/strategies/quickScalpEngine.ts
// Isolated "Quick Scalp" strategy. Does NOT import from or modify signalEngine.ts.
// Pipeline: Daily trend gate -> M5 SMC (FVG) structure entry -> WaveTrend confirmation.
// Fires continuously through the day, but every signal is filtered to daily-trend direction.

import type { Candle } from "../types";
import { computeWaveTrend } from "../indicators/waveTrend";
import { computeDailyTrend, type TrendDirection } from "./dailyTrend";
import { findFVG } from "./smartMoney";

export type QuickScalpDirection = "BUY" | "SELL";

export interface QuickScalpSignal {
  strategy: "quick_scalp";
  direction: QuickScalpDirection;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  reason: string[];
  dailyTrend: TrendDirection;
  waveTrendState: {
    wt1: number;
    wt2: number;
    bullishCross: boolean;
    bearishCross: boolean;
  };
  time: number;
}

export interface QuickScalpInput {
  m5Candles: Candle[];
  dailyCandles: Candle[];
}

interface FVG {
  direction: QuickScalpDirection;
  top: number;
  bottom: number;
}

const MIN_M5_CANDLES = 60;
const SL_BUFFER_POINTS = 0.5; // gold points beyond structure
const RR_TP1 = 1.0;
const RR_TP2 = 2.0;

function validateInput(input: QuickScalpInput): void {
  if (!input || !Array.isArray(input.m5Candles) || !Array.isArray(input.dailyCandles)) {
    throw new Error("QuickScalpEngine: m5Candles and dailyCandles are required arrays");
  }
  if (input.m5Candles.length < MIN_M5_CANDLES) {
    throw new Error(
      `QuickScalpEngine: need at least ${MIN_M5_CANDLES} M5 candles, got ${input.m5Candles.length}`,
    );
  }
  if (input.dailyCandles.length < 55) {
    throw new Error(
      `QuickScalpEngine: need at least 55 daily candles, got ${input.dailyCandles.length}`,
    );
  }
}

/** Map existing SMC findFVG → Quick Scalp FVG shape (no duplicate detector). */
function recentFvgAligned(candles: Candle[], want: QuickScalpDirection): FVG | null {
  const raw = findFVG(candles);
  if (!raw) return null;
  const direction: QuickScalpDirection = raw.type === "bullish" ? "BUY" : "SELL";
  if (direction !== want) return null;
  return { direction, top: raw.high, bottom: raw.low };
}

/** True if the latest close has traded back into the FVG zone (mitigation trigger). */
function priceReturnedToFVG(candles: Candle[], fvg: FVG): boolean {
  const last = candles[candles.length - 1];
  return last.close <= fvg.top && last.close >= fvg.bottom;
}

export function generateQuickScalpSignal(input: QuickScalpInput): QuickScalpSignal | null {
  validateInput(input);

  const daily = computeDailyTrend(input.dailyCandles);
  if (daily.direction === "NEUTRAL") {
    return null; // gate closed: no clear daily bias, no trade regardless of M5 setup
  }

  const wt = computeWaveTrend(input.m5Candles);
  const reason: string[] = [
    `Daily trend: ${daily.direction} (EMA20/50 + structure=${daily.structure})`,
  ];

  const wantDirection: QuickScalpDirection = daily.direction === "BULLISH" ? "BUY" : "SELL";

  const wtConfirms =
    wantDirection === "BUY"
      ? wt.bullishCross && !wt.overbought
      : wt.bearishCross && !wt.oversold;

  if (!wtConfirms) {
    return null; // no fresh momentum trigger aligned with daily bias yet
  }
  reason.push(
    wantDirection === "BUY"
      ? "WaveTrend bullish cross, not overbought"
      : "WaveTrend bearish cross, not oversold",
  );

  const fvg = recentFvgAligned(input.m5Candles, wantDirection);
  if (!fvg) {
    return null; // no matching SMC structure yet
  }
  if (!priceReturnedToFVG(input.m5Candles, fvg)) {
    return null; // FVG exists but price hasn't mitigated it yet — wait, don't chase
  }
  reason.push(
    `M5 FVG (${fvg.direction}) mitigated at ${fvg.bottom.toFixed(2)}-${fvg.top.toFixed(2)}`,
  );

  const last = input.m5Candles[input.m5Candles.length - 1];
  const entry = last.close;
  const structureRisk = wantDirection === "BUY" ? fvg.bottom : fvg.top;
  const sl =
    wantDirection === "BUY"
      ? structureRisk - SL_BUFFER_POINTS
      : structureRisk + SL_BUFFER_POINTS;
  const riskDistance = Math.abs(entry - sl);

  if (riskDistance <= 0 || !isFinite(riskDistance)) {
    return null; // degenerate risk distance — refuse to emit rather than divide by zero
  }

  const tp1 =
    wantDirection === "BUY" ? entry + riskDistance * RR_TP1 : entry - riskDistance * RR_TP1;
  const tp2 =
    wantDirection === "BUY" ? entry + riskDistance * RR_TP2 : entry - riskDistance * RR_TP2;

  return {
    strategy: "quick_scalp",
    direction: wantDirection,
    entry,
    sl,
    tp1,
    tp2,
    reason,
    dailyTrend: daily.direction,
    waveTrendState: {
      wt1: wt.points[wt.points.length - 1].wt1,
      wt2: wt.points[wt.points.length - 1].wt2,
      bullishCross: wt.bullishCross,
      bearishCross: wt.bearishCross,
    },
    time: last.time,
  };
}
