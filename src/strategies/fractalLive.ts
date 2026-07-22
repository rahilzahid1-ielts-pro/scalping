/**
 * TTrades Fractal live — fractal breakout MUST agree with SMC generateSignal side.
 * Plus daily agree + no 2h spike-chase (same SL protection as QS Pro / Quick Scalp).
 * Levels from SMC; TP1 remapped to 0.9R for the tab's bank-quick style.
 */
import type { AssetId, Candle, TradeMode } from "../types";
import { generateFractalSignal } from "./archived/fractalSignal";
import { generateSignal } from "./signalEngine";
import { leanDeskEntryBlock } from "../utils/entryFilters";

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

export function diagnoseFractalLiveGate(input: {
  primary: Candle[];
  confirmation: Candle[];
  bias: Candle[];
  daily: Candle[];
  assetId?: AssetId;
  mode?: TradeMode;
}): { pass: boolean; waitReason: string } {
  const assetId = input.assetId ?? "XAUUSD";
  const mode = input.mode ?? "scalping";

  const fractal = generateFractalSignal({ candles: input.primary });
  if (!fractal) {
    return { pass: false, waitReason: "Fractal breakout nahi" };
  }

  const smc = generateSignal(assetId, mode, {
    primary: input.primary,
    confirmation: input.confirmation,
    bias: input.bias,
    daily: input.daily,
  });
  if (smc.side !== fractal.direction) {
    return {
      pass: false,
      waitReason: "Fractal breakout SMC side se agree nahi",
    };
  }
  if (!smc.levels) {
    return { pass: false, waitReason: "SMC levels missing" };
  }
  const block = leanDeskEntryBlock({
    side: fractal.direction,
    dailyBias: smc.dailyBias.bias,
    primary: input.primary,
  });
  if (block) return { pass: false, waitReason: block };
  return { pass: true, waitReason: "" };
}

export function generateFractalLiveSignal(input: {
  primary: Candle[];
  confirmation: Candle[];
  bias: Candle[];
  daily: Candle[];
  assetId?: AssetId;
  mode?: TradeMode;
}): FractalLiveSignal | null {
  const gate = diagnoseFractalLiveGate(input);
  if (!gate.pass) return null;

  const assetId = input.assetId ?? "XAUUSD";
  const mode = input.mode ?? "scalping";
  const fractal = generateFractalSignal({ candles: input.primary });
  const smc = generateSignal(assetId, mode, {
    primary: input.primary,
    confirmation: input.confirmation,
    bias: input.bias,
    daily: input.daily,
  });
  if (!fractal || !smc.levels || smc.side !== fractal.direction) return null;

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
      `Daily ${smc.dailyBias.bias} agree · no 2h spike-chase`,
      `TP1 @ ${RR_TP1}R — bank at TP1`,
    ],
  };
}
