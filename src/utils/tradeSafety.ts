import type { AssetConfig, Side } from "../types";

export function minRiskPct(assetId: string) {
  if (assetId === "XAGUSD") return 0.0045;
  if (assetId === "XAUUSD") return 0.0018;
  return 0.0025;
}

export function isTooLateToEnter(
  side: Side,
  livePrice: number,
  entry: number,
  stopLoss: number,
): boolean {
  const risk = Math.abs(stopLoss - entry);
  if (risk <= 0) return true;
  if (side === "SELL") {
    if (livePrice >= stopLoss) return true;
    // Price already ran toward target without filling the locked entry.
    return entry - livePrice > risk * 0.5;
  }
  if (side === "BUY") {
    if (livePrice <= stopLoss) return true;
    // Price already ran toward target without filling the locked entry.
    return livePrice - entry > risk * 0.5;
  }
  return true;
}

export function hasSafeStopRoom(
  side: Side,
  entry: number,
  stopLoss: number,
  asset: AssetConfig,
): boolean {
  const room = Math.abs(stopLoss - entry);
  const need = entry * minRiskPct(asset.id);
  if (room < need) return false;
  if (side === "SELL" && stopLoss <= entry) return false;
  if (side === "BUY" && stopLoss >= entry) return false;
  return true;
}

/** Wider zone so small feed lag vs chart still triggers alert */
export function entryTolerance(asset: AssetConfig, mode: "scalping" | "intraday", price: number) {
  if (asset.id === "XAUUSD") return mode === "scalping" ? 1.2 : 1.8;
  if (asset.id === "XAGUSD") return mode === "scalping" ? 0.06 : 0.1;
  return mode === "scalping" ? price * 0.0004 : price * 0.0006;
}

export function isInEntryZone(
  side: Side,
  probePrice: number,
  entry: number,
  tol: number,
): boolean {
  if (side === "BUY") {
    return probePrice <= entry + tol && probePrice >= entry - tol * 1.2;
  }
  if (side === "SELL") {
    return probePrice >= entry - tol && probePrice <= entry + tol * 1.2;
  }
  return false;
}

/** SELL: prefer ask (slightly ahead). BUY: prefer bid. Never use day high/low. */
export function probePriceForSide(
  side: Side,
  displayPrice: number,
  high?: number,
  low?: number,
  ask?: number,
  bid?: number,
): number {
  if (side === "SELL") {
    // Only trust "high" if it's within 0.05% of live (near tick), not session high
    const candidates = [displayPrice, ask ?? 0];
    if (high != null && Math.abs(high - displayPrice) / displayPrice < 0.0005) {
      candidates.push(high);
    }
    return Math.max(...candidates.filter((n) => n > 0)) || displayPrice;
  }
  if (side === "BUY") {
    const candidates = [displayPrice, bid ?? displayPrice];
    if (low != null && Math.abs(low - displayPrice) / displayPrice < 0.0005) {
      candidates.push(low);
    }
    return Math.min(...candidates.filter((n) => n > 0));
  }
  return displayPrice;
}
