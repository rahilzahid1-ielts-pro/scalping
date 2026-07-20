// src/strategies/quickScalpEngine.ts
// Quick Scalp BLITZ — uses proven SMC generateSignal (scalping TFs) + trend gates
// + fast TP1 remap. Isolated table/bot; does not touch alertBot plan locks.
//
// User goal: only when market trending → strong entry → bank quick (TP1) → out.

import type { AssetId, Candle, TradeMode } from "../types";
import { generateSignal } from "./signalEngine";

export type QuickScalpDirection = "BUY" | "SELL";

export interface QuickScalpSignal {
  strategy: "quick_scalp";
  style: "blitz";
  direction: QuickScalpDirection;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  reason: string[];
  dailyTrend: string;
  confidence: number;
  regime: string;
  waveTrendState: {
    wt1: number;
    wt2: number;
    bullishCross: boolean;
    bearishCross: boolean;
  };
  time: number;
}

/** Full multi-TF pack (same shape as generateSignal / fetchMultiTimeframe). */
export interface QuickScalpFrames {
  primary: Candle[];
  confirmation: Candle[];
  bias: Candle[];
  daily: Candle[];
}

/** @deprecated Prefer QuickScalpFrames — kept for type compatibility. */
export interface QuickScalpInput {
  m5Candles: Candle[];
  dailyCandles: Candle[];
}

const PRO_LIKE_MIN_CONF = 75;
const RR_TP1 = 0.85; // fast bank
const RR_TP2 = 1.5;

function isFrames(x: QuickScalpFrames | QuickScalpInput): x is QuickScalpFrames {
  return Array.isArray((x as QuickScalpFrames).primary);
}

/**
 * BLITZ signal: SMC scalping engine + trend/accuracy gates + quick TP1.
 * Returns null when ranging / weak / conflicting.
 */
export function generateQuickScalpSignal(
  framesOrLegacy: QuickScalpFrames | QuickScalpInput,
  assetId: AssetId = "XAUUSD",
  mode: TradeMode = "scalping",
): QuickScalpSignal | null {
  const frames: QuickScalpFrames = isFrames(framesOrLegacy)
    ? framesOrLegacy
    : {
        // Legacy path cannot build HTF — refuse rather than fake accuracy
        primary: framesOrLegacy.m5Candles,
        confirmation: framesOrLegacy.m5Candles,
        bias: framesOrLegacy.m5Candles,
        daily: framesOrLegacy.dailyCandles,
      };

  if (!isFrames(framesOrLegacy)) {
    // Caller must pass full frames for BLITZ; legacy m5-only is insufficient.
    return null;
  }

  const sig = generateSignal(assetId, mode, frames);
  if (sig.side !== "BUY" && sig.side !== "SELL") return null;
  if (!sig.levels) return null;

  const d = sig.diagnostics;
  if (sig.confidence < PRO_LIKE_MIN_CONF) return null;
  if (!d.htfAligned) return null;
  if (d.conflictingSignals || d.conflictCapped) return null;

  const regime = d.regime ?? "";
  if (regime !== "TREND_UP" && regime !== "TREND_DOWN") return null;
  if (sig.side === "BUY" && regime !== "TREND_UP") return null;
  if (sig.side === "SELL" && regime !== "TREND_DOWN") return null;

  if (sig.side === "BUY" && sig.dailyBias.bias !== "BULLISH") return null;
  if (sig.side === "SELL" && sig.dailyBias.bias !== "BEARISH") return null;

  const entry = sig.levels.entry;
  const sl = sig.levels.stopLoss;
  const risk = Math.abs(entry - sl);
  if (risk <= 0 || !isFinite(risk)) return null;

  const tp1 = sig.side === "BUY" ? entry + risk * RR_TP1 : entry - risk * RR_TP1;
  const tp2 = sig.side === "BUY" ? entry + risk * RR_TP2 : entry - risk * RR_TP2;

  return {
    strategy: "quick_scalp",
    style: "blitz",
    direction: sig.side,
    entry,
    sl,
    tp1,
    tp2,
    confidence: sig.confidence,
    regime,
    dailyTrend: sig.dailyBias.bias,
    reason: [
      `BLITZ SMC · conf ${sig.confidence}% · regime ${regime}`,
      `Daily ${sig.dailyBias.bias} · HTF aligned · no conflict`,
      `Fast TP1 @ ${RR_TP1}R — bank quick, don't hold for swing`,
      ...sig.confluence.slice(0, 4),
    ],
    waveTrendState: {
      wt1: 0,
      wt2: 0,
      bullishCross: sig.side === "BUY",
      bearishCross: sig.side === "SELL",
    },
    time: sig.timestamp,
  };
}
