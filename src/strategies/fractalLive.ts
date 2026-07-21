/**
 * TTrades Fractal live — fractal breakout MUST agree with SMC generateSignal side.
 * Lean variant: direction agreement only (no conf/HTF/trend/daily quality stack).
 * Levels from SMC; TP1 remapped to 0.9R for the tab's bank-quick style.
 */
import type { AssetId, Candle, TradeMode } from "../types";
import { generateFractalSignal } from "./archived/fractalSignal";
import { generateSignal } from "./signalEngine";

const RR_TP1 = 0.9;
const RR_TP2 = 1.6;

export interface FractalLiveSignal {
  strategy: "fractal";
  style: "ttrades_fractal_agree";
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  reason: string[];
  time: number;
  dailyTrend: string;
  confidence: number;
}

export function generateFractalLiveSignal(input: {
  primary: Candle[];
  confirmation: Candle[];
  bias: Candle[];
  daily: Candle[];
  assetId?: AssetId;
  mode?: TradeMode;
}): FractalLiveSignal | null {
  const assetId = input.assetId ?? "XAUUSD";
  const mode = input.mode ?? "scalping";

  // Allow SMC up to two M5 bars to confirm a breakout that is still holding.
  // Exact-bar agreement was needlessly dropping fast continuation moves.
  const fractal = generateFractalSignal({
    candles: input.primary,
    maxBreakoutAgeBars: 2,
  });
  if (!fractal) return null;

  const smc = generateSignal(assetId, mode, {
    primary: input.primary,
    confirmation: input.confirmation,
    bias: input.bias,
    daily: input.daily,
  });
  // Sole gate: fractal breakout direction must match main SMC side.
  if (smc.side !== fractal.direction) return null;
  if (!smc.levels) return null;

  const entry = smc.levels.entry;
  const sl = smc.levels.stopLoss;
  const risk = Math.abs(entry - sl);
  if (risk <= 0 || !isFinite(risk)) return null;
  const tp1 =
    fractal.direction === "BUY" ? entry + risk * RR_TP1 : entry - risk * RR_TP1;
  const tp2 =
    fractal.direction === "BUY" ? entry + risk * RR_TP2 : entry - risk * RR_TP2;

  return {
    strategy: "fractal",
    style: "ttrades_fractal_agree",
    direction: fractal.direction,
    entry,
    sl,
    tp1,
    tp2,
    confidence: smc.confidence,
    dailyTrend: smc.dailyBias.bias,
    time: input.primary[input.primary.length - 1].time,
    reason: [
      ...fractal.reason,
      `Fractal agrees with SMC ${smc.side} · conf ${smc.confidence}%`,
      `Lean gate: direction agreement only (no quality stack)`,
      `TP1 @ ${RR_TP1}R — bank at TP1`,
    ],
  };
}
