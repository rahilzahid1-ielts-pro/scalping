/**
 * Intra30 — exact Main Intraday generateSignal path, with ONLY fixed exits:
 *   TP = entry ± $3.00 (30 points)
 *   SL = entry ∓ $6.00 (60 points)
 * No other formula / gate changes vs intraday auto-lock (conf≥72, HTF, no conflict).
 */
import type { AssetId, Candle } from "../types";
import { generateSignal } from "./signalEngine";
import { INTRADAY_LOCK_MIN_CONF } from "../utils/sessionPlan";

export const INTRA30_TP_DISTANCE = 3;
export const INTRA30_SL_DISTANCE = 6;

export type Intra30Direction = "BUY" | "SELL";

export interface Intra30Signal {
  strategy: "intra30";
  direction: Intra30Direction;
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

export interface Intra30Frames {
  primary: Candle[];
  confirmation: Candle[];
  bias: Candle[];
  daily: Candle[];
}

/** Apply the only Intra30 rule on top of an unchanged Intraday entry. */
export function applyIntra30Levels(
  direction: Intra30Direction,
  entry: number,
): { entry: number; sl: number; tp1: number; tp2: number } {
  if (direction === "BUY") {
    const tp1 = entry + INTRA30_TP_DISTANCE;
    return {
      entry,
      sl: entry - INTRA30_SL_DISTANCE,
      tp1,
      tp2: tp1,
    };
  }
  const tp1 = entry - INTRA30_TP_DISTANCE;
  return {
    entry,
    sl: entry + INTRA30_SL_DISTANCE,
    tp1,
    tp2: tp1,
  };
}

/**
 * Same gates as Main Intraday auto-lock (canAutoLockPlan intraday branch),
 * then replace TP/SL with fixed ±3 / ±6.
 */
export function generateIntra30Signal(
  assetId: AssetId,
  frames: Intra30Frames,
): Intra30Signal | null {
  const sig = generateSignal(assetId, "intraday", frames);

  if (sig.side !== "BUY" && sig.side !== "SELL") return null;
  if (!sig.levels) return null;

  if (sig.confidence < INTRADAY_LOCK_MIN_CONF) return null;
  if (sig.diagnostics.conflictingSignals) return null;
  if (!sig.diagnostics.htfAligned) return null;

  const lv = applyIntra30Levels(sig.side, sig.levels.entry);
  const regime = sig.diagnostics.regime ?? "";

  return {
    strategy: "intra30",
    direction: sig.side,
    entry: lv.entry,
    sl: lv.sl,
    tp1: lv.tp1,
    tp2: lv.tp2,
    confidence: sig.confidence,
    regime,
    dailyBias: sig.dailyBias.bias,
    reason: [
      `Intra30 = Intraday copy · TP $${INTRA30_TP_DISTANCE} · SL $${INTRA30_SL_DISTANCE}`,
      `Conf ${sig.confidence}% ≥ ${INTRADAY_LOCK_MIN_CONF} · HTF aligned · no conflict`,
      ...sig.confluence.slice(0, 6),
    ],
    time: sig.timestamp,
  };
}
