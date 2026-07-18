import type { AssetConfig, LiveQuote, LiveSignal, Side } from "../types";
import type { FrozenPlan } from "../services/tradePlan";
import { roundPrice } from "../strategies/indicators";
import { CONFLICT_CAP_PCT } from "../calibration/types";
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
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  safeZoneLow: number | null;
  safeZoneHigh: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  takeProfit2: number | null;
  livePrice: number;
  distanceToEntry: number | null;
  inEntryZone: boolean;
  conflictingSignals: boolean;
  sessionLocked: boolean;
  /** Tier-1 early warning: liquidity sweep against the plan side (display-only). */
  liquidityWarning: boolean;
}

const MIN_CONFIDENCE = 68;

export function computeNowAction(
  signal: LiveSignal,
  plan: FrozenPlan | null,
  livePrice: number,
  asset: AssetConfig,
  quote?: LiveQuote | null,
  /** Tier-1 flag: sweep detected against the locked plan → shave displayed scores. */
  liquidityWarning?: boolean,
): NowActionResult {
  const decimals = asset.decimals;
  const p = roundPrice(livePrice, decimals);
  // A locked plan must keep the scores the user saw when it fired. A later
  // refresh may lean WAIT/opposite, but that is not a new instruction for an
  // already-entered trade.
  // Conflict guardrail (Fix 4): BOTH confidence and win% ≤ CONFLICT_CAP_PCT.
  const conflict =
    Boolean(signal.diagnostics?.conflictingSignals) ||
    Boolean(signal.diagnostics?.conflictCapped);
  let conf = plan?.lockedConfidence ?? signal.confidence;
  let winProb =
    plan?.lockedWinProbability ?? signal.rangePrediction.winProbability;
  if (conflict) {
    conf = Math.min(conf, CONFLICT_CAP_PCT);
    winProb = Math.min(winProb, CONFLICT_CAP_PCT);
  }
  // Tier-1 sweep is surfaced as an informational card flag only. The confidence/
  // win% penalty was REMOVED: backtest showed swept plans win MORE (72.5% vs 46.5%
  // TP1), so shaving their displayed scores was backwards. Detection + logging stay.
  const liqWarn = liquidityWarning === true;
  const tol = entryTolerance(asset, signal.mode, p);
  const empty: NowActionResult = {
    action: "WAIT_SETUP",
    headline: "WAIT",
    headlineUr: "ABHI KUCH MAT KARO",
    detail: "High-probability setup nahi mila. Screen dekhte raho.",
    confidence: conf,
    winProbability: winProb,
    side: "WAIT",
    entry: null,
    entryZoneLow: null,
    entryZoneHigh: null,
    safeZoneLow: null,
    safeZoneHigh: null,
    stopLoss: null,
    takeProfit: null,
    takeProfit2: null,
    livePrice: p,
    distanceToEntry: null,
    inEntryZone: false,
    conflictingSignals: conflict,
    sessionLocked: false,
    liquidityWarning: liqWarn,
  };

  const sessionLocked =
    plan?.mode === "intraday" &&
    !!plan.sessionDate &&
    plan.status !== "INVALIDATED";

  if (plan?.status === "INVALIDATED") {
    return {
      ...empty,
      action: "PLAN_DEAD",
      headline: "PLAN CANCEL",
      headlineUr: "PURANA PLAN KHATAM",
      detail: plan.note || "Plan khatam. New plan dabao.",
      side: plan.side,
      entry: plan.levels.entry,
      entryZoneLow: plan.entryZoneLow ?? null,
      entryZoneHigh: plan.entryZoneHigh ?? null,
      safeZoneLow: plan.safeZoneLow ?? null,
      safeZoneHigh: plan.safeZoneHigh ?? null,
      stopLoss: plan.levels.stopLoss,
      takeProfit: plan.levels.takeProfit1,
      takeProfit2: plan.levels.takeProfit2,
      sessionLocked: false,
      liquidityWarning: liqWarn,
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
      entryZoneLow: plan.entryZoneLow ?? null,
      entryZoneHigh: plan.entryZoneHigh ?? null,
      safeZoneLow: plan.safeZoneLow ?? null,
      safeZoneHigh: plan.safeZoneHigh ?? null,
      stopLoss: plan.levels.stopLoss,
      takeProfit: plan.levels.takeProfit1,
      takeProfit2: plan.levels.takeProfit2,
      livePrice: p,
      distanceToEntry: roundPrice(p - plan.levels.entry, decimals),
      inEntryZone: false,
      conflictingSignals: conflict,
      sessionLocked,
      liquidityWarning: liqWarn,
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
  const tp2 = levels.takeProfit2;
  const zoneLow = plan?.entryZoneLow ?? null;
  const zoneHigh = plan?.entryZoneHigh ?? null;
  const safeLow = plan?.safeZoneLow ?? null;
  const safeHigh = plan?.safeZoneHigh ?? null;

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
      entryZoneLow: zoneLow,
      entryZoneHigh: zoneHigh,
      safeZoneLow: safeLow,
      safeZoneHigh: safeHigh,
      stopLoss: sl,
      takeProfit: tp,
      takeProfit2: tp2,
      livePrice: p,
      distanceToEntry: dist,
      inEntryZone: false,
      conflictingSignals: conflict,
      sessionLocked,
      liquidityWarning: liqWarn,
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
      entryZoneLow: zoneLow,
      entryZoneHigh: zoneHigh,
      safeZoneLow: safeLow,
      safeZoneHigh: safeHigh,
      stopLoss: sl,
      takeProfit: tp,
      takeProfit2: tp2,
      livePrice: p,
      distanceToEntry: dist,
      inEntryZone: false,
      conflictingSignals: conflict,
      sessionLocked,
      liquidityWarning: liqWarn,
    };
  }

  const inZone =
    zoneLow != null && zoneHigh != null
      ? probe >= Math.min(zoneLow, zoneHigh) && probe <= Math.max(zoneLow, zoneHigh)
      : isInEntryZone(side, probe, entry, tol);

  if (inZone) {
    return {
      action: "ENTER_NOW",
      headline: side === "BUY" ? "BUY NOW" : "SELL NOW",
      headlineUr: side === "BUY" ? "AB BUY LO" : "AB SELL LO",
      detail: `ENTRY ZONE HIT (${zoneLow ?? entry}–${zoneHigh ?? entry}). Live ${p} (probe ${probe}). SL ${sl} · TP1 ${tp}. Chart confirm karke LO.`,
      confidence: conf,
      winProbability: winProb,
      side,
      entry,
      entryZoneLow: zoneLow,
      entryZoneHigh: zoneHigh,
      safeZoneLow: safeLow,
      safeZoneHigh: safeHigh,
      stopLoss: sl,
      takeProfit: tp,
      takeProfit2: tp2,
      livePrice: p,
      distanceToEntry: roundPrice(probe - entry, decimals),
      inEntryZone: true,
      conflictingSignals: conflict,
      sessionLocked,
      liquidityWarning: liqWarn,
    };
  }

  const zoneLabel =
    zoneLow != null && zoneHigh != null
      ? `${Math.min(zoneLow, zoneHigh)}–${Math.max(zoneLow, zoneHigh)}`
      : String(entry);

  const waitDetail = sessionLocked
    ? `${side} intraday zone ${zoneLabel} — din bhar LOCKED. Market yahan aaye to ${side}. SL ${sl} · TP1 ${tp} · TP2 ${tp2}. Alert auto bajega.`
    : side === "SELL"
      ? probe < entry
        ? `SELL zone ${zoneLabel} — abhi ${p}. Aur ${roundPrice(entry - probe, decimals)} chahiye. Alert auto bajega.`
        : `Probe ${probe} entry ke paas/upar — zone check. Chart confirm.`
      : probe > entry
        ? `BUY zone ${zoneLabel} — abhi ${p}. Pullback wait. Alert auto bajega.`
        : `Price ${p} — zone ${zoneLabel}.`;

  return {
    action: "WAIT_ENTRY",
    headline: sessionLocked ? "WAIT FOR ZONE" : "WAIT FOR ENTRY",
    headlineUr: sessionLocked ? "ZONE KA WAIT KARO" : "ENTRY KA WAIT KARO",
    detail: waitDetail,
    confidence: conf,
    winProbability: winProb,
    side,
    entry,
    entryZoneLow: zoneLow,
    entryZoneHigh: zoneHigh,
    safeZoneLow: safeLow,
    safeZoneHigh: safeHigh,
    stopLoss: sl,
    takeProfit: tp,
    takeProfit2: tp2,
    livePrice: p,
    distanceToEntry: dist,
    inEntryZone: false,
    conflictingSignals: conflict,
    sessionLocked,
    liquidityWarning: liqWarn,
  };
}
