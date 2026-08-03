/**
 * Probeb reach target — where price can run on a lean (not SL/TP).
 * Strong rules: ATR + recent swing extreme, scaled by quality/confidence.
 * Example: SELL strong @ 4052 → target ~4040.
 */
import type { Candle } from "../types";
import { atr, roundPrice, swingHighsLows } from "../strategies/indicators";
import type { ProbebQuality } from "../strategies/probebEngine";

export type ProbebReach = {
  /** Live / lean price now. */
  now: number;
  /** Predicted level market can reach in favor of the lean. */
  target: number;
  /** $ distance |target − now|. */
  moveUsd: number;
  side: "BUY" | "SELL";
  /** Short line for UI: "SELL → ~4040 tak". */
  label: string;
  method: "swing_atr";
};

const DECIMALS = 2;
const SWING_LOOKBACK = 18;

function favorSwing(
  candles: Candle[],
  side: "BUY" | "SELL",
): number | null {
  if (candles.length < 5) return null;
  const slice = candles.slice(-SWING_LOOKBACK);
  if (side === "SELL") {
    const lo = Math.min(...slice.map((c) => c.low));
    return Number.isFinite(lo) ? lo : null;
  }
  const hi = Math.max(...slice.map((c) => c.high));
  return Number.isFinite(hi) ? hi : null;
}

function lastStructureTarget(
  candles: Candle[],
  side: "BUY" | "SELL",
): number | null {
  const { highs, lows } = swingHighsLows(candles, 2, 2);
  if (side === "SELL") {
    const last = lows[lows.length - 1];
    return last?.price ?? null;
  }
  const last = highs[highs.length - 1];
  return last?.price ?? null;
}

/** How far (ATR mult) a lean can stretch — stronger = farther. */
function atrReachMult(
  quality: ProbebQuality,
  confidencePct: number,
): number {
  const conf = Math.max(0, Math.min(100, confidencePct)) / 100;
  if (quality === "strong") return 1.05 + conf * 0.55; // ~1.05–1.60 ATR
  if (quality === "normal") return 0.7 + conf * 0.35; // ~0.7–1.05 ATR
  return 0.4 + conf * 0.25; // weak: small advisory only
}

/**
 * Build "market kis level pe ja sakti hai" for the current Probeb lean.
 */
export function buildProbebReachTarget(
  candles: Candle[],
  side: "BUY" | "SELL",
  livePrice: number,
  confidencePct = 50,
  quality: ProbebQuality = "normal",
): ProbebReach | null {
  if (!(Number.isFinite(livePrice) && livePrice > 0)) return null;
  if (candles.length < 30) return null;

  const atrSeries = atr(candles, 14);
  const atrVal = atrSeries[atrSeries.length - 1];
  if (!(Number.isFinite(atrVal) && atrVal > 0)) return null;

  const now = roundPrice(livePrice, DECIMALS);
  const mult = atrReachMult(quality, confidencePct);
  const atrTarget =
    side === "SELL" ? now - atrVal * mult : now + atrVal * mult;

  const swing = favorSwing(candles, side);
  const structure = lastStructureTarget(candles, side);

  let target = atrTarget;
  // Prefer a real swing/structure level in the favor direction when it sits
  // between now and the ATR stretch (or slightly beyond on strong).
  const candidates = [swing, structure].filter(
    (x): x is number => x != null && Number.isFinite(x),
  );
  for (const c of candidates) {
    if (side === "SELL") {
      if (c < now && c >= atrTarget - atrVal * 0.25) {
        target = Math.min(target, c);
      }
    } else if (c > now && c <= atrTarget + atrVal * 0.25) {
      target = Math.max(target, c);
    }
  }

  // Strong: if a deeper swing exists within 2×ATR, use it as stretch target.
  if (quality === "strong" && swing != null) {
    if (side === "SELL" && swing < now && now - swing <= atrVal * 2.2) {
      target = Math.min(target, swing);
    }
    if (side === "BUY" && swing > now && swing - now <= atrVal * 2.2) {
      target = Math.max(target, swing);
    }
  }

  target = roundPrice(target, DECIMALS);
  const moveUsd = roundPrice(Math.abs(target - now), DECIMALS);
  if (!(moveUsd >= 0.4)) return null;

  const label =
    side === "SELL"
      ? `SELL → ~${target.toFixed(0)} tak (−$${moveUsd.toFixed(0)})`
      : `BUY → ~${target.toFixed(0)} tak (+$${moveUsd.toFixed(0)})`;

  return {
    now,
    target,
    moveUsd,
    side,
    label,
    method: "swing_atr",
  };
}

/** @deprecated use buildProbebReachTarget — kept name for older imports. */
export const buildProbebSmcLevels = buildProbebReachTarget;

/** @deprecated */
export type ProbebLevels = ProbebReach;
