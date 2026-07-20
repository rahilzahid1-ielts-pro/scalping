/**
 * Pro strategy — strict filter over generateSignal (intraday thresholds).
 * Isolated from Quick Scalp and from alertBot plan locks.
 * Does NOT modify signalEngine lock math — only gates which setups pass.
 */
import type { AssetId, Candle, TradeMode } from "../types";
import { generateSignal } from "./signalEngine";

export type ProDirection = "BUY" | "SELL";

export interface ProSignal {
  strategy: "pro";
  direction: ProDirection;
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

export interface ProFrames {
  primary: Candle[];
  confirmation: Candle[];
  bias: Candle[];
  daily: Candle[];
}

/** Minimum confidence for a Pro setup (stricter than scalp/intraday auto-lock). */
export const PRO_MIN_CONFIDENCE = 80;

/**
 * Generate a Pro signal or null (WAIT / rejected by gates).
 * Default mode = intraday (cleaner HTF path per plan).
 */
export function generateProSignal(
  assetId: AssetId,
  frames: ProFrames,
  mode: TradeMode = "intraday",
): ProSignal | null {
  const sig = generateSignal(assetId, mode, frames);

  if (sig.side !== "BUY" && sig.side !== "SELL") return null;
  if (!sig.levels) return null;

  const d = sig.diagnostics;
  if (sig.confidence < PRO_MIN_CONFIDENCE) return null;
  if (!d.htfAligned) return null;
  if (d.conflictingSignals || d.conflictCapped) return null;

  const regime = d.regime ?? "";
  if (regime !== "TREND_UP" && regime !== "TREND_DOWN") return null;

  // Daily bias must agree with side (not merely "not fighting").
  if (sig.side === "BUY" && sig.dailyBias.bias !== "BULLISH") return null;
  if (sig.side === "SELL" && sig.dailyBias.bias !== "BEARISH") return null;

  // Regime direction should match side.
  if (sig.side === "BUY" && regime !== "TREND_UP") return null;
  if (sig.side === "SELL" && regime !== "TREND_DOWN") return null;

  const reasons = [
    `Pro gates: conf ${sig.confidence}% ≥ ${PRO_MIN_CONFIDENCE}`,
    `HTF aligned · regime ${regime}`,
    `Daily ${sig.dailyBias.bias}`,
    ...sig.confluence.slice(0, 6),
  ];

  return {
    strategy: "pro",
    direction: sig.side,
    entry: sig.levels.entry,
    sl: sig.levels.stopLoss,
    tp1: sig.levels.takeProfit1,
    tp2: sig.levels.takeProfit2,
    confidence: sig.confidence,
    regime,
    dailyBias: sig.dailyBias.bias,
    reason: reasons,
    time: sig.timestamp,
  };
}
