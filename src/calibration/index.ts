import type { LiveSignal } from "../types";
import { logEmittedSignal } from "./logSignal";

/** Build log payload from a generated BUY/SELL signal (with levels). */
export function logSignalFromLive(signal: LiveSignal): ReturnType<typeof logEmittedSignal> {
  if (signal.side === "WAIT" || !signal.levels) return null;
  const d = signal.diagnostics;
  return logEmittedSignal({
    symbol: signal.asset,
    mode: signal.mode,
    side: signal.side,
    entry: signal.levels.entry,
    sl: signal.levels.stopLoss,
    tp1: signal.levels.takeProfit1,
    tp2: signal.levels.takeProfit2,
    tp3: signal.levels.takeProfit3,
    confidence: signal.confidence,
    winChanceDisplayed: signal.rangePrediction.winProbability,
    confluencePct: d.confluencePct,
    smcScore: d.smcScore,
    maScore: d.maScore,
    paScore: d.paScore,
    bullPts: d.bullPts,
    bearPts: d.bearPts,
    htfAligned: d.htfAligned,
    dailyBias: signal.dailyBias.bias,
    conflictingSignals: d.conflictingSignals,
    conflictCapped: d.conflictCapped,
    atr14: d.atr14,
    atrPctOfPrice: d.atrPctOfPrice,
    regime: d.regime,
    timestamp: signal.timestamp,
  });
}

export { deriveRegimeTag } from "./regime";
export { getCalibratedWinChance } from "./recalibrate";
export { displayedWinChance } from "./winChanceDisplay";
export { CONFLICT_CAP_PCT } from "./types";
