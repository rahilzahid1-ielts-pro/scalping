import { ASSETS } from "../config/assets";
import type { AssetId, LiveSignal, Side, TradeLevels, TradeMode } from "../types";
import { roundPrice } from "../strategies/indicators";
import type { FrozenPlan } from "../services/tradePlan";
import { entryTolerance } from "./tradeSafety";

export const SCALP_LOCK_MIN_CONF = 68;
export const INTRADAY_LOCK_MIN_CONF = 72;

/** UTC calendar day key — live uses wall clock; backtest passes bar-close Date. */
export function sessionDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function computeEntryZone(
  side: Side,
  entry: number,
  assetId: AssetId,
  mode: TradeMode,
): { low: number; high: number } {
  const asset = ASSETS[assetId];
  const tol = entryTolerance(asset, mode, entry);
  const d = asset.decimals;
  if (side === "BUY") {
    return {
      low: roundPrice(entry - tol * 1.2, d),
      high: roundPrice(entry + tol, d),
    };
  }
  return {
    low: roundPrice(entry - tol, d),
    high: roundPrice(entry + tol * 1.2, d),
  };
}

export function buildSessionExtras(
  assetId: AssetId,
  mode: TradeMode,
  side: Side,
  levels: TradeLevels,
  signal: LiveSignal,
  asOf: Date = new Date(),
): Pick<
  FrozenPlan,
  "sessionDate" | "entryZoneLow" | "entryZoneHigh" | "safeZoneLow" | "safeZoneHigh"
> {
  const zone = computeEntryZone(side, levels.entry, assetId, mode);
  const d = ASSETS[assetId].decimals;
  const extras: Pick<
    FrozenPlan,
    "sessionDate" | "entryZoneLow" | "entryZoneHigh" | "safeZoneLow" | "safeZoneHigh"
  > = {
    entryZoneLow: zone.low,
    entryZoneHigh: zone.high,
  };

  if (mode === "intraday") {
    extras.sessionDate = sessionDayKey(asOf);
    const rp = signal.rangePrediction;
    extras.safeZoneLow = roundPrice(
      Math.min(rp.from, rp.to, rp.invalidation, rp.pivots.s1, rp.pivots.s2),
      d,
    );
    extras.safeZoneHigh = roundPrice(
      Math.max(rp.from, rp.to, rp.magnetLevel, rp.pivots.r1, rp.pivots.r2),
      d,
    );
  }

  return extras;
}

/** Intraday: one auto-lock per UTC day; higher bar; no re-lock after invalidate without New plan. */
export function canAutoLockPlan(
  mode: TradeMode,
  signal: LiveSignal,
  current: FrozenPlan | null,
  assetId: AssetId,
  asOf: Date = new Date(),
): boolean {
  if (signal.side === "WAIT" || !signal.levels) return false;

  const minConf = mode === "intraday" ? INTRADAY_LOCK_MIN_CONF : SCALP_LOCK_MIN_CONF;
  if (signal.confidence < minConf) return false;

  if (mode === "intraday") {
    if (signal.diagnostics.conflictingSignals) return false;
    if (!signal.diagnostics.htfAligned) return false;

    const today = sessionDayKey(asOf);
    if (
      current &&
      current.mode === "intraday" &&
      current.assetId === assetId &&
      current.sessionDate === today
    ) {
      return false;
    }
  }

  return true;
}

export function signalInterval(mode: TradeMode, hasActivePlan: boolean): number {
  if (mode === "intraday") {
    // Active trade: poll often so locked status + watch-setup stay live.
    return hasActivePlan ? 15_000 : 60_000;
  }
  return 30_000;
}
