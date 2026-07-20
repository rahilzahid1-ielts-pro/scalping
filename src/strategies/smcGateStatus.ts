/**
 * Shared SMC gate diagnostics for Pro / Quick Scalp / Cipher / Fractal live wrappers.
 * Returns null when gates would pass; otherwise a short human reason for WAITING.
 */
import type { Candle, TradeMode, AssetId } from "../types";
import { generateSignal } from "./signalEngine";

export type SmcGateFrames = {
  primary: Candle[];
  confirmation: Candle[];
  bias: Candle[];
  daily: Candle[];
};

export function diagnoseSmcGateBlock(
  frames: SmcGateFrames,
  opts: { assetId?: AssetId; mode: TradeMode; minConf: number },
): { pass: boolean; waitReason: string; side: string; conf: number; regime: string; daily: string } {
  const assetId = opts.assetId ?? "XAUUSD";
  const sig = generateSignal(assetId, opts.mode, frames);
  const d = sig.diagnostics;
  const regime = d.regime ?? "—";
  const daily = sig.dailyBias.bias;
  const side = sig.side;

  if (side !== "BUY" && side !== "SELL") {
    return {
      pass: false,
      waitReason: `SMC flat (${side}) — no clear BUY/SELL`,
      side,
      conf: sig.confidence,
      regime,
      daily,
    };
  }
  if (!sig.levels) {
    return {
      pass: false,
      waitReason: "SMC side hai lekin levels missing",
      side,
      conf: sig.confidence,
      regime,
      daily,
    };
  }
  if (sig.confidence < opts.minConf) {
    return {
      pass: false,
      waitReason: `Conf ${sig.confidence}% < ${opts.minConf}%`,
      side,
      conf: sig.confidence,
      regime,
      daily,
    };
  }
  if (!d.htfAligned) {
    return {
      pass: false,
      waitReason: `HTF not aligned · SMC ${side} · conf ${sig.confidence}%`,
      side,
      conf: sig.confidence,
      regime,
      daily,
    };
  }
  if (d.conflictingSignals || d.conflictCapped) {
    return {
      pass: false,
      waitReason: `Conflict · SMC ${side} blocked`,
      side,
      conf: sig.confidence,
      regime,
      daily,
    };
  }
  if (regime !== "TREND_UP" && regime !== "TREND_DOWN") {
    return {
      pass: false,
      waitReason: `Regime ${regime} (sirf TREND_UP/DOWN)`,
      side,
      conf: sig.confidence,
      regime,
      daily,
    };
  }
  if (side === "BUY" && regime !== "TREND_UP") {
    return {
      pass: false,
      waitReason: `BUY vs regime ${regime}`,
      side,
      conf: sig.confidence,
      regime,
      daily,
    };
  }
  if (side === "SELL" && regime !== "TREND_DOWN") {
    return {
      pass: false,
      waitReason: `SELL vs regime ${regime}`,
      side,
      conf: sig.confidence,
      regime,
      daily,
    };
  }
  if (side === "BUY" && daily !== "BULLISH") {
    return {
      pass: false,
      waitReason: `Daily ${daily} vs SMC BUY — daily agree nahi`,
      side,
      conf: sig.confidence,
      regime,
      daily,
    };
  }
  if (side === "SELL" && daily !== "BEARISH") {
    return {
      pass: false,
      waitReason: `Daily ${daily} vs SMC SELL — daily agree nahi`,
      side,
      conf: sig.confidence,
      regime,
      daily,
    };
  }

  return {
    pass: true,
    waitReason: "",
    side,
    conf: sig.confidence,
    regime,
    daily,
  };
}
