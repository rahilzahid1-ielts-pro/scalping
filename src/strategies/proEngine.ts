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

function isStrongHtfContinuation(
  frames: ProFrames,
  side: ProDirection,
): boolean {
  const primary = frames.primary;
  const confirmation = frames.confirmation;
  if (primary.length < 10 || confirmation.length < 3) return false;

  const last = primary[primary.length - 1];
  const priorPrimary = primary.slice(-10, -1);
  const lastConfirmation = confirmation[confirmation.length - 1];
  const previousConfirmation = confirmation[confirmation.length - 2];

  if (side === "BUY") {
    const priorHigh = Math.max(...priorPrimary.map((c) => c.high));
    return (
      last.close > priorHigh &&
      lastConfirmation.close > lastConfirmation.open &&
      lastConfirmation.close > previousConfirmation.close
    );
  }

  const priorLow = Math.min(...priorPrimary.map((c) => c.low));
  return (
    last.close < priorLow &&
    lastConfirmation.close < lastConfirmation.open &&
    lastConfirmation.close < previousConfirmation.close
  );
}

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

  // Regime direction should match side.
  if (sig.side === "BUY" && regime !== "TREND_UP") return null;
  if (sig.side === "SELL" && regime !== "TREND_DOWN") return null;

  // Normally Daily must agree. A confirmed M15 breakout plus an H1 impulse may
  // override a lagging Daily label; this catches exceptional intraday jumps
  // without weakening confidence, conflict, HTF, or regime gates.
  const dailyAgrees =
    (sig.side === "BUY" && sig.dailyBias.bias === "BULLISH") ||
    (sig.side === "SELL" && sig.dailyBias.bias === "BEARISH");
  const continuationOverride =
    !dailyAgrees &&
    sig.confidence >= PRO_MIN_CONFIDENCE + 5 &&
    isStrongHtfContinuation(frames, sig.side);
  if (!dailyAgrees && !continuationOverride) return null;

  const reasons = [
    `Pro gates: conf ${sig.confidence}% ≥ ${PRO_MIN_CONFIDENCE}`,
    `HTF aligned · regime ${regime}`,
    continuationOverride
      ? `Strong M15+H1 continuation overrides lagging Daily ${sig.dailyBias.bias}`
      : `Daily ${sig.dailyBias.bias}`,
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
