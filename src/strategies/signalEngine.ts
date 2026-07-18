import type {
  AssetId,
  Bias,
  BiasForecast,
  Candle,
  LiveSignal,
  Side,
  TradeLevels,
  TradeMode,
} from "../types";
import type { RegimeTag } from "../calibration/types";
import { ASSETS } from "../config/assets";
import { atr, roundPrice, swingHighsLows } from "./indicators";
import { deriveRegimeTag } from "../calibration/regime";
import { CONFLICT_CAP_PCT } from "../calibration/types";
import { analyzeMovingAverages } from "./movingAverages";
import { analyzeSmartMoney } from "./smartMoney";
import { analyzePriceAction } from "./priceAction";
import { buildRangePrediction } from "./rangePrediction";

/**
 * Regime tag for a primary series using the SAME classifier logged per signal
 * (analyzeMovingAverages + deriveRegimeTag). Lets the backtest recompute regime
 * on a locked bar without re-running the full generateSignal.
 */
export function computeRegime(primary: Candle[]): RegimeTag {
  const price = primary[primary.length - 1]?.close ?? 0;
  const ma = analyzeMovingAverages(primary);
  return deriveRegimeTag(ma, price);
}

function biasFromVotes(votes: Bias[]): Bias {
  const bull = votes.filter((v) => v === "BULLISH").length;
  const bear = votes.filter((v) => v === "BEARISH").length;
  if (bull > bear + 0) return "BULLISH";
  if (bear > bull + 0) return "BEARISH";
  return "NEUTRAL";
}

function buildLevels(
  side: Side,
  price: number,
  candles: Candle[],
  mode: TradeMode,
  decimals: number,
  assetId: AssetId,
  smcOb?: { high: number; low: number },
  swingGuard?: { high: number; low: number },
): TradeLevels | null {
  if (side === "WAIT") return null;

  const atrSeries = atr(candles, 14);
  const atrRaw = atrSeries[atrSeries.length - 1] || price * 0.002;

  // Metals need wider stops — silver especially noisy
  const minPct =
    assetId === "XAGUSD" ? 0.0045 : assetId === "XAUUSD" ? 0.0018 : 0.0025;
  const atrFloor = price * minPct;
  const atrVal = Math.max(atrRaw, atrFloor);

  const multSL = mode === "scalping" ? 1.25 : 1.8;
  const tp1m = mode === "scalping" ? 1.5 : 2.2;
  const tp2m = mode === "scalping" ? 2.4 : 3.5;
  const tp3m = mode === "scalping" ? 3.5 : 5.0;

  // Limit entry: BUY below / SELL above live — never same as chasing mid
  let entry = price;
  if (smcOb) {
    entry = (smcOb.high + smcOb.low) / 2;
  } else if (swingGuard) {
    if (mode === "intraday") {
      entry = side === "BUY" ? swingGuard.low : swingGuard.high;
    } else {
      entry =
        side === "BUY"
          ? swingGuard.low + atrVal * 0.1
          : swingGuard.high - atrVal * 0.1;
    }
  } else {
    const step = atrVal * (mode === "intraday" ? 0.45 : 0.3);
    entry = side === "BUY" ? price - step : price + step;
  }

  // Sanity: only snap when entry is on wrong side of live by a large margin.
  // Intraday keeps SMC/swing zone even if price has moved away (wait for pullback).
  const snapPad = atrVal * (mode === "intraday" ? 0.85 : 0.25);
  if (side === "SELL" && entry < price - snapPad) {
    entry = price + atrVal * (mode === "intraday" ? 0.15 : 0.25);
  }
  if (side === "BUY" && entry > price + snapPad) {
    entry = price - atrVal * (mode === "intraday" ? 0.15 : 0.25);
  }

  let stopLoss: number;
  let takeProfit1: number;
  let takeProfit2: number;
  let takeProfit3: number;

  if (side === "BUY") {
    stopLoss = entry - atrVal * multSL;
    if (smcOb) stopLoss = Math.min(stopLoss, smcOb.low - atrVal * 0.25);
    if (swingGuard) stopLoss = Math.min(stopLoss, swingGuard.low - atrVal * 0.2);
    // Enforce min distance from entry
    stopLoss = Math.min(stopLoss, entry - atrFloor);
    takeProfit1 = entry + atrVal * tp1m;
    takeProfit2 = entry + atrVal * tp2m;
    takeProfit3 = entry + atrVal * tp3m;
  } else {
    stopLoss = entry + atrVal * multSL;
    if (smcOb) stopLoss = Math.max(stopLoss, smcOb.high + atrVal * 0.25);
    if (swingGuard) stopLoss = Math.max(stopLoss, swingGuard.high + atrVal * 0.2);
    stopLoss = Math.max(stopLoss, entry + atrFloor);
    takeProfit1 = entry - atrVal * tp1m;
    takeProfit2 = entry - atrVal * tp2m;
    takeProfit3 = entry - atrVal * tp3m;
  }

  const risk = Math.abs(entry - stopLoss) || 1;
  const reward = Math.abs(takeProfit2 - entry);
  return {
    entry: roundPrice(entry, decimals),
    stopLoss: roundPrice(stopLoss, decimals),
    takeProfit1: roundPrice(takeProfit1, decimals),
    takeProfit2: roundPrice(takeProfit2, decimals),
    takeProfit3: roundPrice(takeProfit3, decimals),
    riskReward: roundPrice(reward / risk, 2),
    invalidation: roundPrice(stopLoss, decimals),
  };
}

function buildDailyBias(daily: Candle[], htf: Candle[]): BiasForecast {
  const ma = analyzeMovingAverages(daily.length > 30 ? daily : htf);
  const smc = analyzeSmartMoney(daily.length > 30 ? daily : htf);
  const pa = analyzePriceAction(daily.length > 30 ? daily : htf);
  const bias = biasFromVotes([ma.trend, smc.structure, pa.bias]);
  const slice = (daily.length ? daily : htf).slice(-20);
  const hi = Math.max(...slice.map((c) => c.high));
  const lo = Math.min(...slice.map((c) => c.low));
  const mid = (hi + lo) / 2;

  const confidence = Math.round(
    ma.score * 0.3 + smc.score * 0.45 + pa.score * 0.25,
  );

  const rationale = [
    ...ma.notes.slice(0, 1),
    ...smc.notes.slice(0, 2),
    `Daily structure favors ${bias}`,
  ];

  return {
    bias,
    confidence: Math.max(35, Math.min(96, confidence)),
    startZone: roundPrice(bias === "BULLISH" ? lo + (mid - lo) * 0.35 : hi - (hi - mid) * 0.35, 4),
    keyLevel: roundPrice(mid, 4),
    rationale,
  };
}

function buildTomorrowBias(daily: Candle[], dailyBias: BiasForecast): BiasForecast {
  if (daily.length < 5) {
    return {
      ...dailyBias,
      rationale: ["Limited daily history — carry forward today's bias with caution"],
    };
  }

  const last = daily[daily.length - 1];
  const prev = daily[daily.length - 2];
  const atrSeries = atr(daily, 14);
  const a = atrSeries[atrSeries.length - 1] || last.close * 0.01;
  const closes = daily.map((c) => c.close);
  const momentum = closes[closes.length - 1] - closes[closes.length - 4];

  let bias = dailyBias.bias;
  let confidence = Math.max(40, dailyBias.confidence - 8);
  const rationale: string[] = [];

  // Continuation if strong close in bias direction + no exhaustion wick
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const range = last.high - last.low || 1;

  if (dailyBias.bias === "BULLISH" && last.close > prev.close && momentum > 0) {
    if (upperWick / range < 0.4) {
      bias = "BULLISH";
      confidence = Math.min(92, confidence + 10);
      rationale.push("Strong bullish daily close → tomorrow continuation favored");
    } else {
      rationale.push("Bullish bias but upper rejection — tomorrow may open with pullback");
      confidence -= 5;
    }
  } else if (dailyBias.bias === "BEARISH" && last.close < prev.close && momentum < 0) {
    if (lowerWick / range < 0.4) {
      bias = "BEARISH";
      confidence = Math.min(92, confidence + 10);
      rationale.push("Strong bearish daily close → tomorrow continuation favored");
    } else {
      rationale.push("Bearish bias but lower rejection — tomorrow may bounce first");
      confidence -= 5;
    }
  } else if (dailyBias.bias === "BULLISH" && last.close < prev.close) {
    rationale.push("Bullish daily bias but red day — expect pullback then buy dips");
    confidence -= 6;
  } else if (dailyBias.bias === "BEARISH" && last.close > prev.close) {
    rationale.push("Bearish daily bias but green day — expect rally then sell rallies");
    confidence -= 6;
  } else {
    rationale.push("Mixed daily impulse — tomorrow lean with HTF structure only");
  }

  const startZone =
    bias === "BULLISH"
      ? last.close - a * 0.55
      : bias === "BEARISH"
        ? last.close + a * 0.55
        : last.close;
  const keyLevel = bias === "BULLISH" ? last.high : bias === "BEARISH" ? last.low : (last.high + last.low) / 2;

  rationale.push(
    bias === "BULLISH"
      ? `Watch open near ${startZone.toFixed(2)}; buy dips toward discount`
      : bias === "BEARISH"
        ? `Watch open near ${startZone.toFixed(2)}; sell rallies into premium`
        : "Wait for London/NY open displacement before committing",
  );

  return {
    bias,
    confidence: Math.max(35, Math.min(94, Math.round(confidence))),
    startZone: roundPrice(startZone, 4),
    keyLevel: roundPrice(keyLevel, 4),
    rationale,
  };
}

export function generateSignal(
  assetId: AssetId,
  mode: TradeMode,
  frames: {
    primary: Candle[];
    confirmation: Candle[];
    bias: Candle[];
    daily: Candle[];
  },
): LiveSignal {
  const asset = ASSETS[assetId];
  const primary = frames.primary;
  const price = primary[primary.length - 1]?.close ?? 0;

  const ma = analyzeMovingAverages(primary);
  const maConfirm = analyzeMovingAverages(frames.confirmation);
  const smc = analyzeSmartMoney(primary);
  const smcHtf = analyzeSmartMoney(frames.bias);
  const pa = analyzePriceAction(primary);

  const confluence: string[] = [];
  let bullPts = 0;
  let bearPts = 0;

  // Weighted confluence — SMC primary, MA filter, PA trigger
  const add = (side: Bias, pts: number, label: string) => {
    if (side === "BULLISH") {
      bullPts += pts;
      confluence.push(`▲ ${label}`);
    } else if (side === "BEARISH") {
      bearPts += pts;
      confluence.push(`▼ ${label}`);
    }
  };

  add(ma.trend, 18, `MA trend ${ma.trend}`);
  add(maConfirm.trend, 12, `Confirm TF MA ${maConfirm.trend}`);
  add(smc.structure, 22, `SMC structure ${smc.structure}`);
  add(smcHtf.structure, 16, `HTF SMC ${smcHtf.structure}`);
  add(pa.bias, 14, `PA: ${pa.pattern}`);

  if (ma.crossover === "bullish") {
    bullPts += 10;
    confluence.push("▲ EMA crossover");
  }
  if (ma.crossover === "bearish") {
    bearPts += 10;
    confluence.push("▼ EMA crossover");
  }
  if (smc.bos === "bullish") {
    bullPts += 12;
    confluence.push("▲ Bullish BOS");
  }
  if (smc.bos === "bearish") {
    bearPts += 12;
    confluence.push("▼ Bearish BOS");
  }
  if (smc.choch === "bullish") {
    bullPts += 11;
    confluence.push("▲ Bullish CHoCH");
  }
  if (smc.choch === "bearish") {
    bearPts += 11;
    confluence.push("▼ Bearish CHoCH");
  }
  if (smc.liquiditySweep === "sell_side") {
    bullPts += 10;
    confluence.push("▲ Sell-side liquidity taken");
  }
  if (smc.liquiditySweep === "buy_side") {
    bearPts += 10;
    confluence.push("▼ Buy-side liquidity taken");
  }
  if (smc.structure === "BULLISH" && smc.premiumDiscount === "discount") {
    bullPts += 12;
    confluence.push("▲ Discount + bullish structure (A+ SMC)");
  }
  if (smc.structure === "BEARISH" && smc.premiumDiscount === "premium") {
    bearPts += 12;
    confluence.push("▼ Premium + bearish structure (A+ SMC)");
  }

  // HTF alignment gate for high probability
  const htfAlignedBull = smcHtf.structure !== "BEARISH" && maConfirm.trend !== "BEARISH";
  const htfAlignedBear = smcHtf.structure !== "BULLISH" && maConfirm.trend !== "BULLISH";

  let side: Side = "WAIT";
  const edge = Math.abs(bullPts - bearPts);
  const minEdge = mode === "scalping" ? 18 : 22;

  if (bullPts > bearPts + minEdge && htfAlignedBull && bullPts >= 45) side = "BUY";
  else if (bearPts > bullPts + minEdge && htfAlignedBear && bearPts >= 45) side = "SELL";

  const rawConf =
    Math.max(bullPts, bearPts) /
      (bullPts + bearPts || 1) *
      100 *
      0.55 +
    smc.score * 0.25 +
    ma.score * 0.12 +
    pa.score * 0.08;

  let confidence = Math.round(rawConf);
  if (side === "WAIT") confidence = Math.min(confidence, 58);
  if (side !== "WAIT" && edge > 35) confidence = Math.min(96, confidence + 8);
  if (side !== "WAIT" && smcHtf.structure === (side === "BUY" ? "BULLISH" : "BEARISH")) {
    confidence = Math.min(97, confidence + 6);
  }
  confidence = Math.max(28, Math.min(97, confidence));

  // Guardrail: MA or primary SMC actively opposes the call → cap confidence (+ win% later)
  const conflictingSignals =
    side !== "WAIT" &&
    ((side === "BUY" && (ma.trend === "BEARISH" || smc.structure === "BEARISH")) ||
      (side === "SELL" && (ma.trend === "BULLISH" || smc.structure === "BULLISH")));
  if (conflictingSignals) {
    confidence = Math.min(confidence, CONFLICT_CAP_PCT);
    confluence.push(
      `⚠ Conflicting signals (MA/SMC vs call) — confidence & win chance capped at ${CONFLICT_CAP_PCT}%`,
    );
  }

  const htfAligned =
    side === "BUY" ? htfAlignedBull : side === "SELL" ? htfAlignedBear : false;
  const confluencePct =
    Math.round(
      (Math.max(bullPts, bearPts) / (bullPts + bearPts || 1)) * 1000,
    ) / 10;

  const ob =
    side === "BUY" && smc.orderBlock?.type === "bullish"
      ? smc.orderBlock
      : side === "SELL" && smc.orderBlock?.type === "bearish"
        ? smc.orderBlock
        : undefined;

  const swings = swingHighsLows(primary, 2, 2);
  const swingGuard =
    swings.highs.length && swings.lows.length
      ? {
          high: swings.highs[swings.highs.length - 1].price,
          low: swings.lows[swings.lows.length - 1].price,
        }
      : undefined;

  const levels = buildLevels(
    side,
    price,
    primary,
    mode,
    asset.decimals,
    assetId,
    ob,
    swingGuard,
  );

  const dailyBias = buildDailyBias(frames.daily, frames.bias);
  const tomorrowBias = buildTomorrowBias(frames.daily, dailyBias);
  let rangePrediction = buildRangePrediction(assetId, mode, frames, price);

  // Soft override: don't fight strong daily bias unless CHoCH
  if (
    side === "BUY" &&
    dailyBias.bias === "BEARISH" &&
    dailyBias.confidence > 70 &&
    smc.choch !== "bullish"
  ) {
    side = "WAIT";
    confidence = Math.min(confidence, 55);
    confluence.push("⛔ Blocked: fighting strong bearish daily bias");
  }
  if (
    side === "SELL" &&
    dailyBias.bias === "BULLISH" &&
    dailyBias.confidence > 70 &&
    smc.choch !== "bearish"
  ) {
    side = "WAIT";
    confidence = Math.min(confidence, 55);
    confluence.push("⛔ Blocked: fighting strong bullish daily bias");
  }

  // Recompute conflict after possible WAIT downgrade — cap BOTH confidence and win chance
  const conflictingFinal =
    side !== "WAIT" &&
    ((side === "BUY" && (ma.trend === "BEARISH" || smc.structure === "BEARISH")) ||
      (side === "SELL" && (ma.trend === "BULLISH" || smc.structure === "BULLISH")));
  const conflictCapped = conflictingFinal;
  if (conflictCapped) {
    confidence = Math.min(confidence, CONFLICT_CAP_PCT);
    rangePrediction = {
      ...rangePrediction,
      confidence: Math.min(rangePrediction.confidence, CONFLICT_CAP_PCT),
      winProbability: Math.min(rangePrediction.winProbability, CONFLICT_CAP_PCT),
    };
  }

  const atrSeriesPrimary = atr(primary, 14);
  const atr14 = atrSeriesPrimary[atrSeriesPrimary.length - 1] || price * 0.002;
  const atrPctOfPrice = price > 0 ? Math.round((atr14 / price) * 100000) / 1000 : 0;
  const regime = deriveRegimeTag(ma, price);

  const timeframeHint =
    mode === "scalping"
      ? "Execute on 1–5m entries · confirm on 15m · bias from 1H"
      : "Execute on 15m entries · confirm on 1H · bias from 4H/Daily";

  let actionPlan: string;
  if (side === "BUY") {
    actionPlan =
      mode === "scalping"
        ? `SCALP BUY: Wait for pullback into discount/OB, enter near ${levels?.entry}, SL ${levels?.stopLoss}, scale out TP1→TP3. Hold minutes to ~1 hour.`
        : `INTRADAY BUY: Align with daily ${dailyBias.bias} bias. Buy dips toward ${levels?.entry}. SL below structure ${levels?.stopLoss}. Trail after TP1.`;
  } else if (side === "SELL") {
    actionPlan =
      mode === "scalping"
        ? `SCALP SELL: Wait for rally into premium/OB, enter near ${levels?.entry}, SL ${levels?.stopLoss}, scale TP1→TP3. Quick in/out.`
        : `INTRADAY SELL: Align with daily ${dailyBias.bias} bias. Sell rallies near ${levels?.entry}. SL above structure ${levels?.stopLoss}. Protect after TP1.`;
  } else {
    actionPlan =
      "WAIT: No high-probability confluence. Do not force. Mark key levels, wait for BOS + MA alignment + PA trigger in HTF direction.";
  }

  return {
    asset: assetId,
    mode,
    side,
    confidence,
    price: roundPrice(price, asset.decimals),
    timestamp: Date.now(),
    ma,
    smc,
    priceAction: pa,
    levels: side === "WAIT" ? null : levels,
    dailyBias: {
      ...dailyBias,
      startZone: roundPrice(dailyBias.startZone, asset.decimals),
      keyLevel: roundPrice(dailyBias.keyLevel, asset.decimals),
    },
    tomorrowBias: {
      ...tomorrowBias,
      startZone: roundPrice(tomorrowBias.startZone, asset.decimals),
      keyLevel: roundPrice(tomorrowBias.keyLevel, asset.decimals),
    },
    rangePrediction,
    confluence,
    actionPlan,
    timeframeHint,
    diagnostics: {
      bullPts,
      bearPts,
      confluencePct,
      smcScore: smc.score,
      maScore: ma.score,
      paScore: pa.score,
      htfAligned: side === "WAIT" ? false : htfAligned,
      conflictingSignals: conflictingFinal,
      conflictCapped,
      atr14: Math.round(atr14 * 1e6) / 1e6,
      atrPctOfPrice,
      regime,
    },
  };
}
