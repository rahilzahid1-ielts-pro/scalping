// src/strategies/dailyTrend.ts
import type { Candle } from "../types";

export type TrendDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface DailyTrendResult {
  direction: TrendDirection;
  ema20: number;
  ema50: number;
  structure: "HH_HL" | "LH_LL" | "MIXED";
  asOfTime: number;
}

const MIN_DAILY_CANDLES = 55;

function ema(values: number[], period: number): number[] {
  if (period <= 0) throw new Error(`ema: invalid period ${period}`);
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

/** Classify recent swing highs/lows as higher-highs/higher-lows, lower-highs/lower-lows, or mixed. */
function classifyStructure(
  daily: Candle[],
  swingWindow = 3,
  lookback = 10,
): "HH_HL" | "LH_LL" | "MIXED" {
  const highs: number[] = [];
  const lows: number[] = [];
  const start = Math.max(swingWindow, daily.length - lookback);

  for (let i = start; i < daily.length - swingWindow; i++) {
    const windowSlice = daily.slice(i - swingWindow, i + swingWindow + 1);
    const isSwingHigh = daily[i].high === Math.max(...windowSlice.map((c) => c.high));
    const isSwingLow = daily[i].low === Math.min(...windowSlice.map((c) => c.low));
    if (isSwingHigh) highs.push(daily[i].high);
    if (isSwingLow) lows.push(daily[i].low);
  }

  if (highs.length < 2 || lows.length < 2) return "MIXED";

  const higherHighs = highs[highs.length - 1] > highs[highs.length - 2];
  const higherLows = lows[lows.length - 1] > lows[lows.length - 2];
  const lowerHighs = highs[highs.length - 1] < highs[highs.length - 2];
  const lowerLows = lows[lows.length - 1] < lows[lows.length - 2];

  if (higherHighs && higherLows) return "HH_HL";
  if (lowerHighs && lowerLows) return "LH_LL";
  return "MIXED";
}

export function computeDailyTrend(dailyCandles: Candle[]): DailyTrendResult {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < MIN_DAILY_CANDLES) {
    throw new Error(
      `computeDailyTrend: need at least ${MIN_DAILY_CANDLES} daily candles, got ${dailyCandles?.length ?? 0}`,
    );
  }
  for (const c of dailyCandles) {
    if ([c.open, c.high, c.low, c.close].some((v) => typeof v !== "number" || !isFinite(v))) {
      throw new Error(`computeDailyTrend: malformed daily candle at time=${c.time}`);
    }
  }

  const closes = dailyCandles.map((c) => c.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const lastEma20 = ema20[ema20.length - 1];
  const lastEma50 = ema50[ema50.length - 1];
  const structure = classifyStructure(dailyCandles);

  // Require EMA direction AND structure to agree — if they conflict, stay NEUTRAL
  // (gate closed) instead of guessing. This is the same "don't force a call" principle
  // used elsewhere in this project (e.g. MA/SMC conflict cap).
  let direction: TrendDirection = "NEUTRAL";
  if (lastEma20 > lastEma50 && structure !== "LH_LL") direction = "BULLISH";
  else if (lastEma20 < lastEma50 && structure !== "HH_HL") direction = "BEARISH";

  return {
    direction,
    ema20: lastEma20,
    ema50: lastEma50,
    structure,
    asOfTime: dailyCandles[dailyCandles.length - 1].time,
  };
}
