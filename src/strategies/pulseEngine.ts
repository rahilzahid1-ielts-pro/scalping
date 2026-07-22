/**
 * QS Pro (Pulse) — best-of hybrid for more trades with solid accuracy.
 *
 * Formula (validated pieces):
 * - SMC generateSignal on scalping TFs (frequency like Quick Scalp)
 * - Fractal direction MUST agree with SMC side
 * - Daily bias MUST agree (same as Quick Scalp — blocks counter-daily chase)
 * - No spike-top / dump chase (2h extension filter)
 * - Fast TP1 @ 0.85R (BLITZ bank) — exit quick
 *
 * Isolated from alertBot / Pro / Quick Scalp locks.
 */
import type { AssetId, Candle, TradeMode } from "../types";
import { generateFractalSignal } from "./archived/fractalSignal";
import { generateSignal } from "./signalEngine";
import { leanDeskEntryBlock } from "../utils/entryFilters";

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

export function diagnosePulseGate(
  frames: PulseFrames,
  assetId: AssetId = "XAUUSD",
  mode: TradeMode = "scalping",
): { pass: boolean; waitReason: string } {
  const fractal = generateFractalSignal({ candles: frames.primary });
  if (!fractal) {
    return { pass: false, waitReason: "QS Pro: fractal breakout nahi" };
  }
  const smc = generateSignal(assetId, mode, frames);
  if (smc.side !== "BUY" && smc.side !== "SELL") {
    return { pass: false, waitReason: "QS Pro: SMC WAIT — no BUY/SELL" };
  }
  if (smc.side !== fractal.direction) {
    return {
      pass: false,
      waitReason: "QS Pro: SMC BUY/SELL + fractal breakout agree chahiye",
    };
  }
  if (!smc.levels) {
    return { pass: false, waitReason: "QS Pro: SMC levels missing" };
  }
  const block = leanDeskEntryBlock({
    side: smc.side,
    dailyBias: smc.dailyBias.bias,
    primary: frames.primary,
  });
  if (block) return { pass: false, waitReason: `QS Pro: ${block}` };
  return { pass: true, waitReason: "" };
}

export function generatePulseSignal(
  frames: PulseFrames,
  assetId: AssetId = "XAUUSD",
  mode: TradeMode = "scalping",
): PulseSignal | null {
  const gate = diagnosePulseGate(frames, assetId, mode);
  if (!gate.pass) return null;

  const fractal = generateFractalSignal({ candles: frames.primary });
  const smc = generateSignal(assetId, mode, frames);
  if (!fractal || (smc.side !== "BUY" && smc.side !== "SELL") || !smc.levels) {
    return null;
  }

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
      `Daily ${smc.dailyBias.bias} agree · no 2h spike-chase · regime ${regime || "—"}`,
      `Fast TP1 @ ${RR_TP1}R — bank quick like BLITZ`,
      ...fractal.reason.slice(0, 2),
      ...smc.confluence.slice(0, 3),
    ],
  };
}
