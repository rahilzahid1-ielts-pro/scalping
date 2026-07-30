import { ASSETS } from "../config/assets";
import type { AssetId, LiveSignal, Side, TradeLevels, TradeMode } from "../types";
import { roundPrice } from "../strategies/indicators";
import type { FrozenPlan } from "../services/tradePlan";
import { dailyAgreesWithSide } from "./entryFilters";
import { entryTolerance } from "./tradeSafety";

export const SCALP_LOCK_MIN_CONF = 68;
/** Was 72 — daily-agree gate carries accuracy; lower bar = more aligned locks. */
export const INTRADAY_LOCK_MIN_CONF = 68;

/** Note marker: SL / zone-miss keeps the day blocked for auto re-lock. */
export const INTRADAY_DAY_STOP_NOTE = "Intraday SL/miss — aaj auto re-lock band";

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

/**
 * Intraday: HTF + no conflict + daily bias agree.
 * Re-lock allowed after TP (plan cleared). SL/zone-miss keeps a day-stop marker.
 */
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
    if (
      (signal.side === "BUY" || signal.side === "SELL") &&
      !dailyAgreesWithSide(signal.side, signal.dailyBias.bias)
    ) {
      return false;
    }

    const today = sessionDayKey(asOf);
    if (
      current &&
      current.mode === "intraday" &&
      current.assetId === assetId &&
      current.sessionDate === today
    ) {
      // Active / waiting zone still owns the day slot.
      if (current.status !== "INVALIDATED") return false;
      // SL or zone-miss day-stop — no auto re-lock until next UTC day.
      if (
        current.note?.includes(INTRADAY_DAY_STOP_NOTE) ||
        current.note?.includes("aaj naya auto plan nahi")
      ) {
        return false;
      }
      // Spent TP marker (legacy) — treat as clear for re-lock.
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
