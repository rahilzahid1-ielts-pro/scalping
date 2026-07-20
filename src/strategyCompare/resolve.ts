import type { Candle } from "../types";

/** First-touch SL vs TP1; same-bar ties prefer SL (matches Quick Scalp / live rules). */
export function resolveBarOutcome(
  direction: "BUY" | "SELL",
  sl: number,
  tp1: number,
  bar: Candle,
): "TP1_HIT" | "SL_HIT" | null {
  const buy = direction === "BUY";
  const hitSl = buy ? bar.low <= sl : bar.high >= sl;
  const hitTp = buy ? bar.high >= tp1 : bar.low <= tp1;
  if (hitSl && hitTp) return "SL_HIT";
  if (hitSl) return "SL_HIT";
  if (hitTp) return "TP1_HIT";
  return null;
}

export function resolveOnBars(
  direction: "BUY" | "SELL",
  sl: number,
  tp1: number,
  bars: Candle[],
  fromIndex: number,
): { outcome: "TP1_HIT" | "SL_HIT"; realizedR: number; at: number } | null {
  for (let i = fromIndex; i < bars.length; i++) {
    const hit = resolveBarOutcome(direction, sl, tp1, bars[i]);
    if (hit) {
      return {
        outcome: hit,
        realizedR: hit === "TP1_HIT" ? 1 : -1,
        at: bars[i].time,
      };
    }
  }
  return null;
}

/** ICT engine expects unix seconds; project candles are UTC ms. */
export function candlesAsUnixSeconds(candles: Candle[]): Candle[] {
  return candles.map((c) => ({
    ...c,
    time: c.time > 1e12 ? Math.floor(c.time / 1000) : c.time,
  }));
}
