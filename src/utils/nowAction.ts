import type { AssetConfig, LiveQuote, LiveSignal, Side } from "../types";
import type { FrozenPlan } from "../services/tradePlan";
import { roundPrice } from "../strategies/indicators";
import {
  entryTolerance,
  hasSafeStopRoom,
  isInEntryZone,
  isTooLateToEnter,
  probePriceForSide,
} from "./tradeSafety";

export type NowAction =
  | "WAIT_SETUP"
  | "WAIT_ENTRY"
  | "ENTER_NOW"
  | "TRADE_ACTIVE"
  | "PLAN_DEAD"
  | "TOO_LATE"
  | "LOW_CONFIDENCE";

export interface NowActionResult {
  action: NowAction;
  headline: string;
  headlineUr: string;
  detail: string;
  confidence: number;
  winProbability: number;
  side: Side;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  livePrice: number;
  distanceToEntry: number | null;
  inEntryZone: boolean;
  conflictingSignals: boolean;
}

const MIN_CONFIDENCE = 68;

export function computeNowAction(
  signal: LiveSignal,
  plan: FrozenPlan | null,
  livePrice: number,
  asset: AssetConfig,
  quote?: LiveQuote | null,
): NowActionResult {
  const decimals = asset.decimals;
  const p = roundPrice(livePrice, decimals);
  // A locked plan must keep the scores the user saw when it fired. A later
  // refresh may lean WAIT/opposite, but that is not a new instruction for an
  // already-entered trade.
  const conf = plan?.lockedConfidence ?? signal.confidence;
  const winProb =
    plan?.lockedWinProbability ?? signal.rangePrediction.winProbability;
  const tol = entryTolerance(asset, signal.mode, p);

  const conflict = signal.diagnostics?.conflictingSignals ?? false;
  const empty: NowActionResult = {
    action: "WAIT_SETUP",
    headline: "WAIT",
    headlineUr: "ABHI KUCH MAT KARO",
    detail: "High-probability setup nahi mila. Screen dekhte raho.",
    confidence: conf,
    winProbability: winProb,
    side: "WAIT",
    entry: null,
    stopLoss: null,
    takeProfit: null,
    livePrice: p,
    distanceToEntry: null,
    inEntryZone: false,
    conflictingSignals: conflict,
  };

  if (plan?.status === "INVALIDATED") {
    return {
      ...empty,
      action: "PLAN_DEAD",
      headline: "PLAN CANCEL",
      headlineUr: "PURANA PLAN KHATAM",
      detail: plan.note || "Plan khatam. New plan dabao.",
      side: plan.side,
      entry: plan.levels.entry,
      stopLoss: plan.levels.stopLoss,
      takeProfit: plan.levels.takeProfit1,
    };
  }

  if (plan?.status === "IN_TRADE_HINT") {
    const tp1Reached =
      (plan.side === "BUY" && p >= plan.levels.takeProfit1) ||
      (plan.side === "SELL" && p <= plan.levels.takeProfit1);
    return {
      action: "TRADE_ACTIVE",
      headline: `${plan.side} TRADE ACTIVE`,
      headlineUr: `${plan.side} TRADE CHAL RAHI HAI`,
      detail: tp1Reached
        ? `TP1 ${plan.levels.takeProfit1} reach ho gaya. Remaining position ko plan ke mutabiq manage karo; SL ${plan.levels.stopLoss}.`
        : `Entered ${plan.side} @ ${plan.levels.entry}. Fresh signal is trade ko cancel nahi karta. SL ${plan.levels.stopLoss} · TP1 ${plan.levels.takeProfit1}.`,
      confidence: conf,
      winProbability: winProb,
      side: plan.side,
      entry: plan.levels.entry,
      stopLoss: plan.levels.stopLoss,
      takeProfit: plan.levels.takeProfit1,
      livePrice: p,
      distanceToEntry: roundPrice(p - plan.levels.entry, decimals),
      inEntryZone: false,
      conflictingSignals: conflict,
    };
  }

  const side = plan?.side ?? signal.side;
  const levels = plan?.levels ?? signal.levels;

  if (side === "WAIT" || !levels) {
    if (conf < MIN_CONFIDENCE) {
      return {
        ...empty,
        action: "LOW_CONFIDENCE",
        headline: "WAIT",
        headlineUr: "ABHI TRADE MAT LO",
        detail: `Confidence ${conf}% — ${MIN_CONFIDENCE}%+ chahiye.`,
      };
    }
    return empty;
  }

  const entry = levels.entry;
  const sl = levels.stopLoss;
  const tp = levels.takeProfit1;

  // Probe = high-side for SELL so chart-ahead ticks still fire alert
  const probe = roundPrice(
    probePriceForSide(side, p, quote?.high, quote?.low, quote?.ask, quote?.bid),
    decimals,
  );
  const dist = p - entry;

  // Only TOO_LATE if probe clearly chewed into SL risk (not feed noise)
  if (
    (side === "SELL" && probe >= sl) ||
    (side === "BUY" && probe <= sl) ||
    isTooLateToEnter(side, probe, entry, sl)
  ) {
    return {
      action: "TOO_LATE",
      headline: "DO NOT ENTER",
      headlineUr: "AB ENTRY MAT LO",
      detail: `Price entry miss / SL zone. Locked entry ${entry} — chase mat karo. New plan.`,
      confidence: conf,
      winProbability: winProb,
      side,
      entry,
      stopLoss: sl,
      takeProfit: tp,
      livePrice: p,
      distanceToEntry: dist,
      inEntryZone: false,
      conflictingSignals: conflict,
    };
  }

  if (!hasSafeStopRoom(side, entry, sl, asset)) {
    return {
      action: "TOO_LATE",
      headline: "DO NOT ENTER",
      headlineUr: "AB ENTRY MAT LO",
      detail: `SL unsafe vs entry. New plan lo.`,
      confidence: conf,
      winProbability: winProb,
      side,
      entry,
      stopLoss: sl,
      takeProfit: tp,
      livePrice: p,
      distanceToEntry: dist,
      inEntryZone: false,
      conflictingSignals: conflict,
    };
  }

  const inZone = isInEntryZone(side, probe, entry, tol);

  if (inZone) {
    return {
      action: "ENTER_NOW",
      headline: side === "BUY" ? "BUY NOW" : "SELL NOW",
      headlineUr: side === "BUY" ? "AB BUY LO" : "AB SELL LO",
      detail: `ENTRY HIT @ ${entry}. Live ${p} (probe ${probe}). SL ${sl} · TP1 ${tp}. Chart confirm karke LO.`,
      confidence: Math.max(conf, 68),
      winProbability: winProb,
      side,
      entry, // keep LOCKED entry — do not swap to live
      stopLoss: sl,
      takeProfit: tp,
      livePrice: p,
      distanceToEntry: roundPrice(probe - entry, decimals),
      inEntryZone: true,
      conflictingSignals: conflict,
    };
  }

  const waitDetail =
    side === "SELL"
      ? probe < entry
        ? `SELL limit ${entry} — abhi ${p}. Aur ${roundPrice(entry - probe, decimals)} chahiye. Alert auto bajega.`
        : `Probe ${probe} entry ke paas/upar — zone check. Chart confirm.`
      : probe > entry
        ? `BUY limit ${entry} — abhi ${p}. Pullback wait. Alert auto bajega.`
        : `Price ${p} — limit ${entry}.`;

  return {
    action: "WAIT_ENTRY",
    headline: "WAIT FOR ENTRY",
    headlineUr: "ENTRY KA WAIT KARO",
    detail: waitDetail,
    confidence: conf,
    winProbability: winProb,
    side,
    entry,
    stopLoss: sl,
    takeProfit: tp,
    livePrice: p,
    distanceToEntry: dist,
    inEntryZone: false,
    conflictingSignals: conflict,
  };
}
