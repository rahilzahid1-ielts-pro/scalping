/**
 * Short Scalp — Main Scalp live path.
 *
 * Strong one-direction impulse: fresh trendConfirm arm (M=3) + SMC agree +
 * impulse body + chase/bounce clear. Fixed ±$2.50 TP/SL. Bank at TP1.
 *
 * Does not modify shared buildLevels / QS Pro / Pro / Cipher.
 */
import type { AssetId, Candle, TradeMode } from "../types";
import { leanDeskEntryBlock } from "../utils/entryFilters";
import {
  evaluateTrendConfirm,
  type TrendTracker,
} from "../utils/trendConfirm";
import type { RegimeTag } from "../calibration/types";
import { computeRegime, generateSignal } from "./signalEngine";

/** Mid of 20–30 pips → $2.50 XAUUSD (repo: $3 ≈ 30 pips). */
export const SHORT_SCALP_DISTANCE = 2.5;

/** Last closed bar body must be at least this fraction of its range. */
export const SHORT_SCALP_IMPULSE_BODY_FRAC = 0.48;

/** Slightly faster arm than global M=4 so more clean impulses qualify. */
export const SHORT_SCALP_CONFIRM_BARS = 3;

export type ShortScalpFrames = {
  primary: Candle[];
  confirmation: Candle[];
  bias: Candle[];
  daily: Candle[];
};

export type ShortScalpSignal = {
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp: number;
  confidence: number;
  reason: string;
  waitReason: "";
};

export type ShortScalpDiagnose = {
  pass: boolean;
  waitReason: string;
  signal: ShortScalpSignal | null;
};

function htfRegimesFrom(frames: ShortScalpFrames): (RegimeTag | null)[] {
  return [
    frames.confirmation.length ? computeRegime(frames.confirmation) : null,
    frames.bias.length ? computeRegime(frames.bias) : null,
  ];
}

function levelsFor(direction: "BUY" | "SELL", entry: number) {
  if (direction === "BUY") {
    return {
      entry,
      sl: entry - SHORT_SCALP_DISTANCE,
      tp: entry + SHORT_SCALP_DISTANCE,
    };
  }
  return {
    entry,
    sl: entry + SHORT_SCALP_DISTANCE,
    tp: entry - SHORT_SCALP_DISTANCE,
  };
}

/** True when last closed M5 is a directional impulse candle. */
export function isImpulseBar(
  primary: Candle[],
  direction: "BUY" | "SELL",
  minBodyFrac = SHORT_SCALP_IMPULSE_BODY_FRAC,
): boolean {
  if (primary.length < 2) return false;
  const bar = primary[primary.length - 1];
  const range = bar.high - bar.low;
  if (!(range > 0) || !Number.isFinite(range)) return false;
  const body = Math.abs(bar.close - bar.open);
  if (body / range < minBodyFrac) return false;
  if (direction === "BUY") return bar.close > bar.open;
  return bar.close < bar.open;
}

/**
 * Diagnose + optionally emit Short Scalp at the current closed bar.
 * Advances `tracker` via evaluateTrendConfirm (same as alertBot).
 */
export function diagnoseShortScalp(
  frames: ShortScalpFrames,
  tracker: TrendTracker,
  livePrice: number,
  opts?: {
    assetId?: AssetId;
    mode?: TradeMode;
    confirmBars?: number;
    barTime?: number;
  },
): ShortScalpDiagnose {
  if (!Number.isFinite(livePrice) || frames.primary.length < 50) {
    return { pass: false, waitReason: "ShortScalp: candles/price missing", signal: null };
  }

  const assetId = opts?.assetId ?? "XAUUSD";
  const mode: TradeMode = opts?.mode ?? "scalping";
  const confirmBars = opts?.confirmBars ?? SHORT_SCALP_CONFIRM_BARS;
  const barTime =
    opts?.barTime ??
    frames.primary[frames.primary.length - 1]?.time ??
    Date.now();

  const regime = computeRegime(frames.primary);
  const htf = htfRegimesFrom(frames);
  const { newEvent, armed, dir } = evaluateTrendConfirm(
    tracker,
    regime,
    frames.primary,
    htf,
    barTime,
    confirmBars,
  );

  if (dir !== "BUY" && dir !== "SELL") {
    return {
      pass: false,
      waitReason: "ShortScalp: no strong TREND_UP/DOWN yet",
      signal: null,
    };
  }
  // Accept fresh EVENT or still-armed window (first bar that clears SMC+impulse).
  if (!armed && !newEvent) {
    return {
      pass: false,
      waitReason: `ShortScalp: waiting fresh ${dir} trend arm (quiet / mid-run)`,
      signal: null,
    };
  }

  const smc = generateSignal(assetId, mode, frames);
  if (smc.side !== dir) {
    return {
      pass: false,
      waitReason: `ShortScalp: trend ${dir} vs SMC ${smc.side} — agree chahiye`,
      signal: null,
    };
  }

  if (!isImpulseBar(frames.primary, dir)) {
    return {
      pass: false,
      waitReason: `ShortScalp: ${dir} impulse bar nahi (weak body)`,
      signal: null,
    };
  }

  const leanBlock = leanDeskEntryBlock({
    side: dir,
    dailyBias: smc.dailyBias.bias,
    primary: frames.primary,
  });
  if (leanBlock) {
    return {
      pass: false,
      waitReason: `ShortScalp: ${leanBlock}`,
      signal: null,
    };
  }

  const lv = levelsFor(dir, livePrice);
  const confidence = Math.max(80, smc.confidence);
  return {
    pass: true,
    waitReason: "",
    signal: {
      direction: dir,
      entry: lv.entry,
      sl: lv.sl,
      tp: lv.tp,
      confidence,
      reason: `ShortScalp · ${dir} @ ${livePrice.toFixed(2)} · ±$${SHORT_SCALP_DISTANCE.toFixed(2)} · SMC agree · impulse`,
      waitReason: "",
    },
  };
}

export function generateShortScalpSignal(
  frames: ShortScalpFrames,
  tracker: TrendTracker,
  livePrice: number,
  opts?: {
    assetId?: AssetId;
    mode?: TradeMode;
    confirmBars?: number;
    barTime?: number;
  },
): ShortScalpSignal | null {
  return diagnoseShortScalp(frames, tracker, livePrice, opts).signal;
}
