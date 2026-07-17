import type { Candle, MaSignal } from "../types";
import { ema } from "./indicators";

export function analyzeMovingAverages(candles: Candle[]): MaSignal {
  const closes = candles.map((c) => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, Math.min(200, Math.max(50, closes.length - 1)));

  const i = closes.length - 1;
  const prev = Math.max(0, i - 1);
  const ema9 = e9[i];
  const ema21 = e21[i];
  const ema50 = e50[i];
  const ema200 = e200[i];
  const price = closes[i];

  const notes: string[] = [];
  let score = 50;
  let alignment = 0;

  const bullStack = ema9 > ema21 && ema21 > ema50 && ema50 > ema200;
  const bearStack = ema9 < ema21 && ema21 < ema50 && ema50 < ema200;

  if (bullStack) {
    alignment = 100;
    score += 22;
    notes.push("EMA stack fully bullish (9>21>50>200)");
  } else if (bearStack) {
    alignment = -100;
    score += 22;
    notes.push("EMA stack fully bearish (9<21<50<200)");
  } else {
    const ups = [ema9 > ema21, ema21 > ema50, price > ema50, price > ema200].filter(Boolean).length;
    alignment = Math.round((ups / 4) * 100 - 50) * 2;
    score += Math.abs(alignment) * 0.12;
    notes.push(`Partial MA alignment (${ups}/4 bullish checks)`);
  }

  let crossover: MaSignal["crossover"] = "none";
  if (e9[prev] <= e21[prev] && ema9 > ema21) {
    crossover = "bullish";
    score += 12;
    notes.push("Bullish EMA 9/21 crossover");
  } else if (e9[prev] >= e21[prev] && ema9 < ema21) {
    crossover = "bearish";
    score += 12;
    notes.push("Bearish EMA 9/21 crossover");
  }

  if (price > ema200) {
    notes.push("Price above EMA200 — higher-timeframe bullish filter");
    score += 6;
  } else {
    notes.push("Price below EMA200 — higher-timeframe bearish filter");
    score += 6;
  }

  const trend =
    bullStack || (price > ema50 && ema9 > ema21)
      ? "BULLISH"
      : bearStack || (price < ema50 && ema9 < ema21)
        ? "BEARISH"
        : "NEUTRAL";

  if (trend === "NEUTRAL") score -= 8;

  return {
    trend,
    ema9,
    ema21,
    ema50,
    ema200,
    alignment,
    crossover,
    score: Math.max(0, Math.min(100, Math.round(score))),
    notes,
  };
}
