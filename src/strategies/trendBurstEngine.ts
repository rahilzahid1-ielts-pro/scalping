/**
 * TrendBurst — measurement-only engine.
 *
 * Strong-trend gate = existing `evaluateTrendConfirm` (M=4 + ATR14 expansion +
 * HTF agree). Fixed symmetric ±$3.00 TP/SL (live EA convention).
 *
 * Variants:
 *   A solo     — fire at confirmation EVENT (newEvent), market entry
 *   B gated    — same + SMC generateSignal() must agree
 *   C pullback — wait while armed for a shallow pullback-then-resume, then enter
 *
 * Fully additive — does not modify Main Scalp / Intraday / other modules.
 * No live tab, API, or bot wiring yet.
 */
import type { AssetId, Candle, Side, TradeMode } from "../types";
import { computeRegime, generateSignal } from "./signalEngine";
import { ema } from "./indicators";
import type { RegimeTag } from "../calibration/types";
import {
  TREND_CONFIRM_BARS,
  evaluateTrendConfirm,
  markTrendConsumed,
  type TrendTracker,
} from "../utils/trendConfirm";

/** Live EA FixedTpSlDistance — $3.00 XAUUSD price units ("30 pips"). */
export const TREND_BURST_DISTANCE = 3;

/** Minimum pullback depth (XAUUSD price units) below the prior 3-bar extreme. */
export const TREND_BURST_PULLBACK_DEPTH = 0.5;

/** EMA period used for pullback-resume filter. */
export const TREND_BURST_EMA_PERIOD = 9;

export type TrendBurstVariant = "solo" | "gated" | "pullback";

export type TrendBurstSignal = {
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp: number;
  variant: TrendBurstVariant;
  /** True when this bar is the once-per-run confirmation EVENT (solo/gated). */
  newEvent: boolean;
  reason: string;
};

export type TrendBurstFrames = {
  primary: Candle[];
  confirmation: Candle[];
  bias: Candle[];
  daily: Candle[];
};

function levelsFor(direction: "BUY" | "SELL", entry: number) {
  if (direction === "BUY") {
    return {
      entry,
      sl: entry - TREND_BURST_DISTANCE,
      tp: entry + TREND_BURST_DISTANCE,
    };
  }
  return {
    entry,
    sl: entry + TREND_BURST_DISTANCE,
    tp: entry - TREND_BURST_DISTANCE,
  };
}

function htfRegimesFrom(frames: TrendBurstFrames): (RegimeTag | null)[] {
  return [
    frames.confirmation.length ? computeRegime(frames.confirmation) : null,
    frames.bias.length ? computeRegime(frames.bias) : null,
  ];
}

/**
 * Shallow pullback then resume while a fresh trend is armed.
 * BUY: low dips ≥ depth below prior 3-bar low OR below EMA9, and close
 * recovers above EMA9 and above the previous close. SELL is the mirror.
 */
export function isPullbackResume(
  primary: Candle[],
  direction: "BUY" | "SELL",
  depth: number = TREND_BURST_PULLBACK_DEPTH,
): boolean {
  if (primary.length < TREND_BURST_EMA_PERIOD + 4) return false;
  const bar = primary[primary.length - 1];
  const prior = primary[primary.length - 2];
  const lookback = primary.slice(-4, -1);
  if (lookback.length < 3) return false;

  const closes = primary.map((c) => c.close);
  const emaSeries = ema(closes, TREND_BURST_EMA_PERIOD);
  const ema9 = emaSeries[emaSeries.length - 1];
  if (!Number.isFinite(ema9)) return false;

  if (direction === "BUY") {
    const prior3Low = Math.min(...lookback.map((c) => c.low));
    const dipped = bar.low <= prior3Low - depth || bar.low < ema9;
    const resumed = bar.close > ema9 && bar.close > prior.close;
    return dipped && resumed;
  }

  const prior3High = Math.max(...lookback.map((c) => c.high));
  const dipped = bar.high >= prior3High + depth || bar.high > ema9;
  const resumed = bar.close < ema9 && bar.close < prior.close;
  return dipped && resumed;
}

/**
 * Evaluate TrendBurst at the current closed bar.
 *
 * - solo / gated: fire only on confirmation `newEvent`
 * - pullback: fire on first pullback-resume while `armed`, then consume the run
 */
export function generateTrendBurstSignal(
  frames: TrendBurstFrames,
  tracker: TrendTracker,
  livePrice: number,
  variant: TrendBurstVariant,
  opts?: {
    assetId?: AssetId;
    mode?: TradeMode;
    confirmBars?: number;
    barTime?: number;
  },
): TrendBurstSignal | null {
  if (!Number.isFinite(livePrice) || frames.primary.length < 50) return null;

  const assetId = opts?.assetId ?? "XAUUSD";
  const mode: TradeMode = opts?.mode ?? "scalping";
  const confirmBars = opts?.confirmBars ?? TREND_CONFIRM_BARS;
  const barTime =
    opts?.barTime ?? frames.primary[frames.primary.length - 1]?.time ?? Date.now();

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

  if (dir !== "BUY" && dir !== "SELL") return null;

  if (variant === "pullback") {
    if (!armed) return null;
    if (!isPullbackResume(frames.primary, dir)) return null;
    markTrendConsumed(tracker);
    const lv = levelsFor(dir, livePrice);
    return {
      direction: dir,
      entry: lv.entry,
      sl: lv.sl,
      tp: lv.tp,
      variant,
      newEvent: false,
      reason: `TrendBurst-pullback · ${dir} resume @ ${livePrice.toFixed(2)} · ±$${TREND_BURST_DISTANCE.toFixed(2)}`,
    };
  }

  if (!newEvent) return null;

  if (variant === "gated") {
    const smc = generateSignal(assetId, mode, frames);
    if (smc.side !== dir) return null;
  }

  const lv = levelsFor(dir, livePrice);
  return {
    direction: dir,
    entry: lv.entry,
    sl: lv.sl,
    tp: lv.tp,
    variant,
    newEvent: true,
    reason:
      variant === "solo"
        ? `TrendBurst-solo · ${dir} market @ ${livePrice.toFixed(2)} · ±$${TREND_BURST_DISTANCE.toFixed(2)}`
        : `TrendBurst-gated · ${dir} market @ ${livePrice.toFixed(2)} · SMC agree · ±$${TREND_BURST_DISTANCE.toFixed(2)}`,
  };
}

/** Apply the trusted backtest spread convention to a raw close fill. */
export function applyTrendBurstSpread(
  side: Side,
  close: number,
  spread: number,
): number {
  if (side === "WAIT" || spread <= 0) return close;
  return side === "BUY" ? close + spread : close - spread;
}
