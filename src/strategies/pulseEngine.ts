/**
 * QS Pro (Pulse) — best-of hybrid for more trades with solid accuracy.
 *
 * Formula (validated pieces):
 * - SMC generateSignal on scalping TFs (frequency like Quick Scalp)
 * - Fractal direction MUST agree with SMC side (best gate-lift; no quality stack)
 * - Fast TP1 @ 0.85R (BLITZ bank) — exit quick
 *
 * Isolated from alertBot / Pro / Quick Scalp locks.
 */
import type { AssetId, Candle, TradeMode } from "../types";
import { generateFractalSignal } from "./archived/fractalSignal";
import { generateSignal } from "./signalEngine";

const RR_TP1 = 0.85;
const RR_TP2 = 1.5;

export type PulseDirection = "BUY" | "SELL";

export interface PulseSignal {
  strategy: "pulse";
  style: "qs_pro";
  direction: PulseDirection;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  confidence: number;
  regime: string;
  dailyBias: string;
  reason: string[];
  time: number;
}

export interface PulseFrames {
  primary: Candle[];
  confirmation: Candle[];
  bias: Candle[];
  daily: Candle[];
}

export function generatePulseSignal(
  frames: PulseFrames,
  assetId: AssetId = "XAUUSD",
  mode: TradeMode = "scalping",
): PulseSignal | null {
  // SMC commonly confirms one or two M5 bars after the actual fractal cross.
  // Keep only that short continuation window; older breakouts remain invalid.
  const fractal = generateFractalSignal({
    candles: frames.primary,
    maxBreakoutAgeBars: 2,
  });
  if (!fractal) return null;

  const smc = generateSignal(assetId, mode, frames);
  if (smc.side !== "BUY" && smc.side !== "SELL") return null;
  if (smc.side !== fractal.direction) return null;
  if (!smc.levels) return null;

  const entry = smc.levels.entry;
  const sl = smc.levels.stopLoss;
  const risk = Math.abs(entry - sl);
  if (risk <= 0 || !isFinite(risk)) return null;

  const tp1 = smc.side === "BUY" ? entry + risk * RR_TP1 : entry - risk * RR_TP1;
  const tp2 = smc.side === "BUY" ? entry + risk * RR_TP2 : entry - risk * RR_TP2;
  const regime = smc.diagnostics.regime ?? "";

  return {
    strategy: "pulse",
    style: "qs_pro",
    direction: smc.side,
    entry,
    sl,
    tp1,
    tp2,
    confidence: smc.confidence,
    regime,
    dailyBias: smc.dailyBias.bias,
    time: frames.primary[frames.primary.length - 1]?.time ?? smc.timestamp,
    reason: [
      `QS Pro · SMC ${smc.side} + fractal agree · conf ${smc.confidence}%`,
      `Lean gate (no quality stack) · regime ${regime || "—"} · daily ${smc.dailyBias.bias}`,
      `Fast TP1 @ ${RR_TP1}R — bank quick like BLITZ`,
      ...fractal.reason.slice(0, 2),
      ...smc.confluence.slice(0, 3),
    ],
  };
}
