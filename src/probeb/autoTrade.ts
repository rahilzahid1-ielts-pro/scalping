/**
 * Probeb → demo auto ±$2.
 *
 * Gate: win%>60 + quality strong + conf≥40.
 * No chase block — STRONG impulse near extremes is the setup (chase was
 * skipping the exact strong candles the desk wants filled).
 * Day stop (−3R) does not apply here — Probeb is its own ±$2 desk; day lock
 * (+5R) still banks a green day.
 */
import { takeDemoTrade } from "../demoAccount/engine";
import {
  DEMO_STARTING_BALANCE,
  ensureDemoAccount,
  findDemoBySourceId,
} from "../demoAccount/store";
import {
  DEMO_DAY_LOCK_R,
  demoDayClosedPnl,
} from "../regime/positiveDayDesk";
import type { Candle } from "../types";
import type { ProbebPrediction } from "../strategies/probebEngine";

/** Price distance for SL and TP1 (XAUUSD $). */
export const PROBEB_AUTO_DISTANCE = 2;

/** Win% must be strictly above this. */
export const PROBEB_AUTO_WIN_MIN = Number(process.env.PROBEB_AUTO_WIN_MIN) || 60;

export const PROBEB_AUTO_CONF_MIN = Number(process.env.PROBEB_AUTO_CONF_MIN) || 40;

export function probebAutoTradeEnabled(): boolean {
  const v = (process.env.ENABLE_PROBEB_AUTO_TRADE ?? "1").toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** Full gate — STRONG only. */
export function isProbebAutoTradeSetup(pred: ProbebPrediction): boolean {
  return (
    pred.probabilityPct > PROBEB_AUTO_WIN_MIN &&
    pred.quality === "strong" &&
    pred.confidencePct >= PROBEB_AUTO_CONF_MIN
  );
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

export type ProbebAutoTradeOpts = {
  primary?: Candle[];
};

/**
 * Open demo ±$2 on STRONG lean.
 */
export function tryProbebAutoTrade(
  pred: ProbebPrediction,
  livePrice: number,
  _opts?: ProbebAutoTradeOpts,
): ProbebAutoTradeResult {
  if (!probebAutoTradeEnabled()) {
    return { ok: false, reason: "ENABLE_PROBEB_AUTO_TRADE off" };
  }
  if (!isProbebAutoTradeSetup(pred)) {
    return {
      ok: false,
      reason: `need STRONG + win>${PROBEB_AUTO_WIN_MIN} + conf≥${PROBEB_AUTO_CONF_MIN} (got ${pred.quality} win ${pred.probabilityPct}% conf ${pred.confidencePct}%)`,
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
    note: `Probeb STRONG auto ±$${d} · win ${pred.probabilityPct}% · conf ${pred.confidencePct}%`,
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
