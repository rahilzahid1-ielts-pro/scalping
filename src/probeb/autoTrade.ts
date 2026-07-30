/**
 * Probeb → demo auto trade ±$2 when Winning % > 60.
 * One fill per M5 barTime. Demo auto-follow + day stop/lock still apply.
 */
import { takeDemoTrade } from "../demoAccount/engine";
import {
  DEMO_STARTING_BALANCE,
  ensureDemoAccount,
  findDemoBySourceId,
} from "../demoAccount/store";
import {
  DEMO_DAY_LOCK_R,
  DEMO_DAY_STOP_R,
  demoDayClosedPnl,
} from "../regime/positiveDayDesk";
import type { ProbebPrediction } from "../strategies/probebEngine";

/** Price distance for SL and TP1 (XAUUSD $). */
export const PROBEB_AUTO_DISTANCE = 2;

/** Win% must be strictly above this (user: "60% se zyda"). */
export const PROBEB_AUTO_WIN_MIN = Number(process.env.PROBEB_AUTO_WIN_MIN) || 60;

export function probebAutoTradeEnabled(): boolean {
  const v = (process.env.ENABLE_PROBEB_AUTO_TRADE ?? "1").toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** Auto-trade gate: winning probability above 60%. */
export function isProbebAutoTradeSetup(pred: ProbebPrediction): boolean {
  return pred.probabilityPct > PROBEB_AUTO_WIN_MIN;
}

export type ProbebAutoTradeResult =
  | {
      ok: true;
      entry: number;
      sl: number;
      tp1: number;
      positionId: string;
    }
  | { ok: false; reason: string };

/**
 * Open a demo position at live mid with ±$2 SL/TP when win% > 60.
 */
export function tryProbebAutoTrade(
  pred: ProbebPrediction,
  livePrice: number,
): ProbebAutoTradeResult {
  if (!probebAutoTradeEnabled()) {
    return { ok: false, reason: "ENABLE_PROBEB_AUTO_TRADE off" };
  }
  if (!isProbebAutoTradeSetup(pred)) {
    return {
      ok: false,
      reason: `win ${pred.probabilityPct}% ≤ ${PROBEB_AUTO_WIN_MIN}% — skip`,
    };
  }
  if (!(Number.isFinite(livePrice) && livePrice > 0)) {
    return { ok: false, reason: "no live price" };
  }

  const sourceId = `probeb-auto-${pred.barTime}`;
  if (findDemoBySourceId(sourceId)) {
    return { ok: false, reason: "already opened this M5" };
  }

  const acct = ensureDemoAccount();
  if (!acct.autoFollow) {
    return { ok: false, reason: "Demo auto-follow OFF" };
  }

  const bank =
    acct.startingBalance > 0 ? acct.startingBalance : DEMO_STARTING_BALANCE;
  const unit = Math.round(((bank * acct.riskPct) / 100) * 100) / 100;
  const { pnlUsd } = demoDayClosedPnl();
  const dayNetR = unit > 0 ? pnlUsd / unit : 0;
  if (dayNetR <= DEMO_DAY_STOP_R) {
    return {
      ok: false,
      reason: `day stop ${dayNetR.toFixed(2)}R — no new Probeb auto`,
    };
  }
  if (dayNetR >= DEMO_DAY_LOCK_R) {
    return {
      ok: false,
      reason: `day lock +${dayNetR.toFixed(2)}R — bank green, no new auto`,
    };
  }

  const d = PROBEB_AUTO_DISTANCE;
  const entry = Math.round(livePrice * 1000) / 1000;
  const sl =
    pred.side === "BUY"
      ? Math.round((entry - d) * 1000) / 1000
      : Math.round((entry + d) * 1000) / 1000;
  const tp1 =
    pred.side === "BUY"
      ? Math.round((entry + d) * 1000) / 1000
      : Math.round((entry - d) * 1000) / 1000;

  const res = takeDemoTrade({
    side: pred.side,
    entry,
    sl,
    tp1,
    tp2: tp1,
    module: "probeb",
    sourceId,
    note: `Probeb auto ±$${d} · win ${pred.probabilityPct}% · conf ${pred.confidencePct}%`,
    regime: null,
  });

  if (!res.ok) return { ok: false, reason: res.error };
  return {
    ok: true,
    entry,
    sl,
    tp1,
    positionId: res.position.id,
  };
}
