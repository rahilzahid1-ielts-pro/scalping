/**
 * TTrades Fractal live — fractal breakout MUST agree with SMC generateSignal.
 * Only fires when both align (trend + conf + HTF). Accuracy over frequency.
 */
import type { AssetId, Candle, TradeMode } from "../types";
import { generateFractalSignal } from "./archived/fractalSignal";
import { generateSignal } from "./signalEngine";

const MIN_CONF = 72;
const RR_TP1 = 0.9;
const RR_TP2 = 1.6;

export interface FractalLiveSignal {
  strategy: "fractal";
  style: "ttrades_fractal_smc";
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

  const fractal = generateFractalSignal({ candles: input.primary });
  if (!fractal) return null;

  const smc = generateSignal(assetId, mode, {
    primary: input.primary,
    confirmation: input.confirmation,
    bias: input.bias,
    daily: input.daily,
  });
  if (smc.side !== fractal.direction) return null;
  if (!smc.levels) return null;
  if (smc.confidence < MIN_CONF) return null;
  if (!smc.diagnostics.htfAligned) return null;
  if (smc.diagnostics.conflictingSignals || smc.diagnostics.conflictCapped) return null;
  const regime = smc.diagnostics.regime ?? "";
  if (regime !== "TREND_UP" && regime !== "TREND_DOWN") return null;
  if (fractal.direction === "BUY" && regime !== "TREND_UP") return null;
  if (fractal.direction === "SELL" && regime !== "TREND_DOWN") return null;
  if (fractal.direction === "BUY" && smc.dailyBias.bias !== "BULLISH") return null;
  if (fractal.direction === "SELL" && smc.dailyBias.bias !== "BEARISH") return null;

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
    style: "ttrades_fractal_smc",
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
      `TTrades Fractal + SMC dual confirm · conf ${smc.confidence}% · ${regime}`,
      `Daily ${smc.dailyBias.bias} · HTF aligned`,
      `TP1 @ ${RR_TP1}R — bank at TP1`,
    ],
  };
}
