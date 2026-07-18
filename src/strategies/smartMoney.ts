import type { Candle, SmcSignal } from "../types";
import { swingHighsLows } from "./indicators";

function detectBOS(candles: Candle[]) {
  const { highs, lows } = swingHighsLows(candles, 3, 2);
  if (highs.length < 2 || lows.length < 2) {
    return { bos: "none" as const, choch: "none" as const, structure: "NEUTRAL" as const };
  }

  const lastHigh = highs[highs.length - 1];
  const prevHigh = highs[highs.length - 2];
  const lastLow = lows[lows.length - 1];
  const prevLow = lows[lows.length - 2];
  const price = candles[candles.length - 1].close;

  let structure: SmcSignal["structure"] = "NEUTRAL";
  let bos: SmcSignal["bos"] = "none";
  let choch: SmcSignal["choch"] = "none";

  const hh = lastHigh.price > prevHigh.price;
  const hl = lastLow.price > prevLow.price;
  const lh = lastHigh.price < prevHigh.price;
  const ll = lastLow.price < prevLow.price;

  if (hh && hl) structure = "BULLISH";
  else if (lh && ll) structure = "BEARISH";

  if (price > lastHigh.price && structure !== "BEARISH") {
    bos = "bullish";
  } else if (price < lastLow.price && structure !== "BULLISH") {
    bos = "bearish";
  }

  if (structure === "BULLISH" && ll) choch = "bearish";
  if (structure === "BEARISH" && hh) choch = "bullish";

  return { bos, choch, structure, lastHigh, lastLow, prevHigh, prevLow };
}

function findOrderBlock(candles: Candle[], bias: SmcSignal["structure"]) {
  const lookback = Math.min(40, candles.length - 3);
  for (let i = candles.length - 3; i >= candles.length - lookback; i--) {
    const c = candles[i];
    const next = candles[i + 1];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low || 1;
    const impulsive = Math.abs(next.close - next.open) > body * 1.4;

    if (bias === "BULLISH" && c.close < c.open && next.close > next.open && impulsive) {
      return { type: "bullish" as const, high: c.high, low: c.low };
    }
    if (bias === "BEARISH" && c.close > c.open && next.close < next.open && impulsive) {
      return { type: "bearish" as const, high: c.high, low: c.low };
    }
    if (range > 0 && body / range < 0.35) continue;
  }
  return undefined;
}

function findFVG(candles: Candle[]) {
  for (let i = candles.length - 2; i >= Math.max(2, candles.length - 30); i--) {
    const c0 = candles[i - 2];
    const c2 = candles[i];
    if (c0.high < c2.low) {
      return { type: "bullish" as const, high: c2.low, low: c0.high };
    }
    if (c0.low > c2.high) {
      return { type: "bearish" as const, high: c0.low, low: c2.high };
    }
  }
  return undefined;
}

/**
 * Standard SMC liquidity sweep on the working timeframe (reuses swingHighsLows):
 * price wicks past a recent swing level (grabbing resting stops) then closes back
 * on the other side within a couple of bars — a stop-hunt, not a genuine breakout.
 *   buy_side  = swept a swing HIGH then closed back below  → bearish reversal cue
 *   sell_side = swept a swing LOW  then closed back above  → bullish reversal cue
 * Exported so the Tier-1 early-warning layer uses the exact same detection.
 */
export function detectLiquiditySweep(
  candles: Candle[],
): "buy_side" | "sell_side" | "none" {
  if (candles.length < 10) return "none" as const;
  const { highs, lows } = swingHighsLows(candles, 2, 1);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  if (highs.length) {
    const eq = highs[highs.length - 1].price;
    if (prev.high > eq && last.close < eq) return "buy_side" as const;
  }
  if (lows.length) {
    const eq = lows[lows.length - 1].price;
    if (prev.low < eq && last.close > eq) return "sell_side" as const;
  }
  return "none" as const;
}

function premiumDiscount(candles: Candle[]) {
  const slice = candles.slice(-50);
  const hi = Math.max(...slice.map((c) => c.high));
  const lo = Math.min(...slice.map((c) => c.low));
  const price = candles[candles.length - 1].close;
  const pos = (price - lo) / (hi - lo || 1);
  if (pos > 0.62) return "premium" as const;
  if (pos < 0.38) return "discount" as const;
  return "equilibrium" as const;
}

export function analyzeSmartMoney(candles: Candle[]): SmcSignal {
  const struct = detectBOS(candles);
  const ob = findOrderBlock(candles, struct.structure);
  const fvg = findFVG(candles);
  const sweep = detectLiquiditySweep(candles);
  const pd = premiumDiscount(candles);
  const notes: string[] = [];
  let score = 45;

  notes.push(`Market structure: ${struct.structure}`);
  if (struct.bos !== "none") {
    score += 16;
    notes.push(`Break of Structure (${struct.bos.toUpperCase()})`);
  }
  if (struct.choch !== "none") {
    score += 14;
    notes.push(`Change of Character (${struct.choch.toUpperCase()}) — early reversal cue`);
  }
  if (ob) {
    score += 12;
    notes.push(`${ob.type} order block ${ob.low.toFixed(2)}–${ob.high.toFixed(2)}`);
  }
  if (fvg) {
    score += 10;
    notes.push(`${fvg.type} FVG / imbalance zone`);
  }
  if (sweep === "sell_side") {
    score += 12;
    notes.push("Sell-side liquidity sweep → bullish continuation setup");
  } else if (sweep === "buy_side") {
    score += 12;
    notes.push("Buy-side liquidity sweep → bearish continuation setup");
  }

  if (struct.structure === "BULLISH" && pd === "discount") {
    score += 10;
    notes.push("Price in discount of range — smart money buy zone");
  } else if (struct.structure === "BEARISH" && pd === "premium") {
    score += 10;
    notes.push("Price in premium of range — smart money sell zone");
  } else if (pd === "equilibrium") {
    notes.push("Equilibrium — wait for displacement into premium/discount");
    score -= 5;
  }

  return {
    structure: struct.structure,
    bos: struct.bos,
    choch: struct.choch,
    orderBlock: ob,
    fvg,
    liquiditySweep: sweep,
    premiumDiscount: pd,
    score: Math.max(0, Math.min(100, Math.round(score))),
    notes,
  };
}
