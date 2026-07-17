import { randomUUID } from "node:crypto";
import { findByPlanKey, insertSignal, makePlanKey } from "./db";
import { getCalibratedWinChance } from "./recalibrate";
import type { LoggedSignal, RegimeTag } from "./types";
import { CONFLICT_CAP_PCT } from "./types";

export type LogSignalInput = {
  symbol: LoggedSignal["symbol"];
  mode: LoggedSignal["mode"];
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
  winChanceDisplayed: number;
  confluencePct: number;
  smcScore: number;
  maScore: number;
  paScore: number;
  bullPts: number;
  bearPts: number;
  htfAligned: boolean;
  dailyBias: string;
  conflictingSignals: boolean;
  conflictCapped?: boolean;
  atr14?: number | null;
  atrPctOfPrice?: number | null;
  regime?: RegimeTag | null;
  timestamp?: number;
};

/**
 * Append one BUY/SELL plan row. Dedupes via UNIQUE(plan_key) + INSERT OR IGNORE.
 * Values logged must match what the user saw (conflict caps applied upstream).
 */
export function logEmittedSignal(input: LogSignalInput): LoggedSignal | null {
  if (input.side !== "BUY" && input.side !== "SELL") return null;

  const planKey = makePlanKey(
    input.symbol,
    input.mode,
    input.side,
    input.entry,
    input.sl,
    input.tp1,
  );
  const existing = findByPlanKey(planKey);
  if (existing) return existing;

  const conflictCapped =
    input.conflictCapped ??
    (input.conflictingSignals &&
      (input.confidence <= CONFLICT_CAP_PCT ||
        input.winChanceDisplayed <= CONFLICT_CAP_PCT));

  const cal = getCalibratedWinChance(input.confidence, input.side, input.mode);
  let winChanceCalibrated = cal.ready ? cal.calibrated : null;
  if (winChanceCalibrated != null && conflictCapped) {
    winChanceCalibrated = Math.min(winChanceCalibrated, CONFLICT_CAP_PCT);
  }

  const row: LoggedSignal = {
    id: randomUUID(),
    timestamp: input.timestamp ?? Date.now(),
    symbol: input.symbol,
    mode: input.mode,
    side: input.side,
    entry: input.entry,
    sl: input.sl,
    tp1: input.tp1,
    tp2: input.tp2,
    tp3: input.tp3,
    confidence: input.confidence,
    winChanceDisplayed: input.winChanceDisplayed,
    winChanceCalibrated,
    confluencePct: input.confluencePct,
    smcScore: input.smcScore,
    maScore: input.maScore,
    paScore: input.paScore,
    bullPts: input.bullPts,
    bearPts: input.bearPts,
    htfAligned: input.htfAligned,
    dailyBias: input.dailyBias,
    conflictingSignals: input.conflictingSignals,
    conflictCapped: Boolean(conflictCapped),
    planKey,
    outcome: "OPEN",
    outcomeTp1: null,
    resolvedAt: null,
    realizedR: null,
    realizedRFull: null,
    fullPlanClosed: false,
    tp2Hit: false,
    tp3Hit: false,
    slAfterTp1: false,
    tp1HitAt: null,
    tp2HitAt: null,
    tp3HitAt: null,
    slAfterTp1At: null,
    atr14: input.atr14 ?? null,
    atrPctOfPrice: input.atrPctOfPrice ?? null,
    regime: input.regime ?? null,
  };

  return insertSignal(row);
}
