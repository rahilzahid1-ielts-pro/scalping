import type { Bias, Candle, RangePrediction, TradeMode } from "../types";
import { ASSETS } from "../config/assets";
import type { AssetId } from "../types";
import { atr, classicPivots, roundPrice, rsi, swingHighsLows } from "./indicators";
import { analyzeMovingAverages } from "./movingAverages";
import { analyzeSmartMoney } from "./smartMoney";
import { analyzePriceAction } from "./priceAction";

/**
 * Stable path prediction: "from X → to Y" with confidence.
 * Uses ATR projection + pivots + RSI + SMC structure (not tick noise).
 */
export function buildRangePrediction(
  assetId: AssetId,
  mode: TradeMode,
  frames: {
    primary: Candle[];
    confirmation: Candle[];
    bias: Candle[];
    daily: Candle[];
  },
  livePrice: number,
): RangePrediction {
  const asset = ASSETS[assetId];
  const d = asset.decimals;
  const daily = frames.daily.length > 5 ? frames.daily : frames.bias;
  const htf = frames.bias;
  const primary = frames.primary;

  const ma = analyzeMovingAverages(htf);
  const smc = analyzeSmartMoney(htf);
  const pa = analyzePriceAction(primary);
  const maDaily = analyzeMovingAverages(daily);
  const smcDaily = analyzeSmartMoney(daily);

  const atrPrimary = atr(primary, 14);
  const atrDaily = atr(daily, 14);
  const atrP = atrPrimary[atrPrimary.length - 1] || livePrice * 0.002;
  const atrD = atrDaily[atrDaily.length - 1] || livePrice * 0.008;

  const closes = primary.map((c) => c.close);
  const rsiSeries = rsi(closes, 14);
  const rsiNow = rsiSeries[rsiSeries.length - 1];
  const rsiVal = Number.isFinite(rsiNow) ? rsiNow : 50;

  const prevDay = daily.length >= 2 ? daily[daily.length - 2] : daily[daily.length - 1];
  const piv = classicPivots(prevDay.high, prevDay.low, prevDay.close);

  const { highs, lows } = swingHighsLows(htf, 3, 2);
  const lastSwingHigh = highs.at(-1)?.price ?? Math.max(...htf.slice(-20).map((c) => c.high));
  const lastSwingLow = lows.at(-1)?.price ?? Math.min(...htf.slice(-20).map((c) => c.low));

  // Direction vote
  let bull = 0;
  let bear = 0;
  const reasons: string[] = [];

  const vote = (b: Bias, w: number, why: string) => {
    if (b === "BULLISH") {
      bull += w;
      reasons.push(`▲ ${why}`);
    } else if (b === "BEARISH") {
      bear += w;
      reasons.push(`▼ ${why}`);
    }
  };

  vote(smcDaily.structure, 24, `Daily SMC ${smcDaily.structure}`);
  vote(maDaily.trend, 16, `Daily MA ${maDaily.trend}`);
  vote(smc.structure, 18, `HTF SMC ${smc.structure}`);
  vote(ma.trend, 12, `HTF MA ${ma.trend}`);
  vote(pa.bias, 10, `PA ${pa.pattern}`);

  if (rsiVal < 35) {
    bull += 12;
    reasons.push("▲ RSI oversold — bounce / continuation long bias");
  } else if (rsiVal > 65) {
    bear += 12;
    reasons.push("▼ RSI overbought — fade / continuation short bias");
  } else {
    reasons.push(`RSI neutral @ ${rsiVal.toFixed(0)}`);
  }

  if (smc.premiumDiscount === "discount" && smc.structure !== "BEARISH") {
    bull += 10;
    reasons.push("▲ Price in discount zone");
  }
  if (smc.premiumDiscount === "premium" && smc.structure !== "BULLISH") {
    bear += 10;
    reasons.push("▼ Price in premium zone");
  }

  // Momentum of last 3 daily closes
  if (daily.length >= 4) {
    const m = daily[daily.length - 1].close - daily[daily.length - 4].close;
    if (m > atrD * 0.15) {
      bull += 8;
      reasons.push("▲ 3-day momentum up");
    } else if (m < -atrD * 0.15) {
      bear += 8;
      reasons.push("▼ 3-day momentum down");
    }
  }

  const direction: Bias =
    bull > bear + 8 ? "BULLISH" : bear > bull + 8 ? "BEARISH" : "NEUTRAL";

  // Projection distance by mode
  const reach =
    mode === "scalping"
      ? atrP * (1.1 + Math.min(1.2, Math.abs(bull - bear) / 80))
      : atrD * (0.55 + Math.min(0.9, Math.abs(bull - bear) / 90));

  let from = livePrice;
  let to: number;
  let invalidation: number;
  let magnet: number;

  if (direction === "BULLISH") {
    // Prefer buying from discount / S1 / swing low area toward R1 / swing high
    from = Math.min(livePrice, piv.s1, lastSwingLow + atrP * 0.15);
    // If already extended above, use current as from
    if (livePrice > piv.pp) from = roundPrice((livePrice + piv.pp) / 2, d);
    to = Math.max(piv.r1, lastSwingHigh, livePrice + reach);
    if (mode === "scalping") to = livePrice + reach;
    magnet = piv.r1;
    invalidation = Math.min(piv.s2, from - atrP * (mode === "scalping" ? 0.9 : 1.2));
    reasons.push(
      `Target magnet R1/swing ${roundPrice(magnet, d)} · ATR reach ${roundPrice(reach, d)}`,
    );
  } else if (direction === "BEARISH") {
    from = Math.max(livePrice, piv.r1, lastSwingHigh - atrP * 0.15);
    if (livePrice < piv.pp) from = roundPrice((livePrice + piv.pp) / 2, d);
    to = Math.min(piv.s1, lastSwingLow, livePrice - reach);
    if (mode === "scalping") to = livePrice - reach;
    magnet = piv.s1;
    invalidation = Math.max(piv.r2, from + atrP * (mode === "scalping" ? 0.9 : 1.2));
    reasons.push(
      `Target magnet S1/swing ${roundPrice(magnet, d)} · ATR reach ${roundPrice(reach, d)}`,
    );
  } else {
    from = piv.s1;
    to = piv.r1;
    magnet = piv.pp;
    invalidation = livePrice < piv.pp ? piv.s2 : piv.r2;
    reasons.push("Range day — fade extremes between S1 and R1 until break");
  }

  // Ensure from/to order matches direction narrative
  if (direction === "BULLISH" && to < from) to = from + Math.abs(reach);
  if (direction === "BEARISH" && to > from) to = from - Math.abs(reach);

  const edge = Math.abs(bull - bear);
  const total = bull + bear || 1;
  let confidence = Math.round((Math.max(bull, bear) / total) * 55 + edge * 0.35 + 20);
  if (direction === "NEUTRAL") confidence = Math.min(confidence, 58);
  if (smcDaily.structure === direction) confidence += 8;
  if (maDaily.trend === direction) confidence += 6;
  if (
    (direction === "BULLISH" && rsiVal < 40) ||
    (direction === "BEARISH" && rsiVal > 60)
  ) {
    confidence += 5;
  }
  confidence = Math.max(38, Math.min(94, confidence));

  // Winning probability — stricter than raw confidence
  let winProb = confidence - 6;
  if (smc.structure === direction && ma.trend === direction) winProb += 8;
  if (pa.bias === direction) winProb += 5;
  if (direction === "NEUTRAL") winProb = Math.min(winProb, 52);
  winProb = Math.max(35, Math.min(92, Math.round(winProb)));

  const horizon =
    mode === "scalping"
      ? "Next 15–90 minutes (scalp path)"
      : "Today's session path (intraday)";

  const summary =
    direction === "NEUTRAL"
      ? `Range play: expect chop between ${roundPrice(from, d)} and ${roundPrice(to, d)} until break.`
      : `High-probability path: ${roundPrice(from, d)} → ${roundPrice(to, d)} (${direction}). Invalid if breaks ${roundPrice(invalidation, d)}.`;

  return {
    direction,
    from: roundPrice(from, d),
    to: roundPrice(to, d),
    confidence,
    winProbability: winProb,
    invalidation: roundPrice(invalidation, d),
    magnetLevel: roundPrice(magnet, d),
    atrReach: roundPrice(reach, d),
    rsi: roundPrice(rsiVal, 1),
    pivots: {
      pp: roundPrice(piv.pp, d),
      r1: roundPrice(piv.r1, d),
      s1: roundPrice(piv.s1, d),
      r2: roundPrice(piv.r2, d),
      s2: roundPrice(piv.s2, d),
    },
    reasons: reasons.slice(0, 8),
    horizon,
    summary,
  };
}
