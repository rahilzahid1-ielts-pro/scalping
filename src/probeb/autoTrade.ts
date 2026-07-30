/**
 * Probeb → demo auto ±$2 — protected after 2 SL autopsy (30 Jul).
 *
 * Failure mode: next-candle CLOSE lean was opened as immediate ±$2 scalp;
 * gold M5 noise + wrong direction → fast SL. Guards below cut that.
 *
 * Gate: win%>60 + quality strong + conf≥40 + no chase + ≤1 Probeb SL today.
 */
import { takeDemoTrade } from "../demoAccount/engine";
import {
  DEMO_ACCOUNT_ID,
  DEMO_STARTING_BALANCE,
  ensureDemoAccount,
  findDemoBySourceId,
  getDemoDb,
} from "../demoAccount/store";
import {
  DEMO_DAY_LOCK_R,
  DEMO_DAY_STOP_R,
  demoDayClosedPnl,
} from "../regime/positiveDayDesk";
import { karachiDayBounds, karachiYmd } from "../history/apiHistory";
import { isExtendedChase } from "../utils/entryFilters";
import type { Candle } from "../types";
import type { ProbebPrediction } from "../strategies/probebEngine";

/** Price distance for SL and TP1 (XAUUSD $). */
export const PROBEB_AUTO_DISTANCE = 2;

/** Win% must be strictly above this. */
export const PROBEB_AUTO_WIN_MIN = Number(process.env.PROBEB_AUTO_WIN_MIN) || 60;

export const PROBEB_AUTO_CONF_MIN = Number(process.env.PROBEB_AUTO_CONF_MIN) || 40;

/** After this many Probeb SL hits today, no more auto opens. */
export const PROBEB_AUTO_MAX_SL_TODAY = Number(process.env.PROBEB_AUTO_MAX_SL) || 1;

export function probebAutoTradeEnabled(): boolean {
  const v = (process.env.ENABLE_PROBEB_AUTO_TRADE ?? "1").toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** Full gate — not win% alone (that caused the 2 quick BUY SLs). */
export function isProbebAutoTradeSetup(pred: ProbebPrediction): boolean {
  return (
    pred.probabilityPct > PROBEB_AUTO_WIN_MIN &&
    pred.quality === "strong" &&
    pred.confidencePct >= PROBEB_AUTO_CONF_MIN
  );
}

export function countProbebSlToday(date = karachiYmd()): number {
  ensureDemoAccount();
  const { start, end } = karachiDayBounds(date);
  const row = getDemoDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM demo_positions
       WHERE account_id = ?
         AND module = 'probeb'
         AND status = 'CLOSED'
         AND outcome = 'SL_HIT'
         AND closed_at IS NOT NULL
         AND closed_at >= ? AND closed_at <= ?`,
    )
    .get(DEMO_ACCOUNT_ID, start, end) as { n: number };
  return Number(row?.n ?? 0);
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
 * Open demo ±$2 only on STRONG lean, with chase + 1-SL day pause.
 */
export function tryProbebAutoTrade(
  pred: ProbebPrediction,
  livePrice: number,
  opts?: ProbebAutoTradeOpts,
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

  const slToday = countProbebSlToday();
  if (slToday >= PROBEB_AUTO_MAX_SL_TODAY) {
    return {
      ok: false,
      reason: `Probeb already ${slToday} SL aaj — auto pause (max ${PROBEB_AUTO_MAX_SL_TODAY})`,
    };
  }

  const sourceId = `probeb-auto-${pred.barTime}`;
  if (findDemoBySourceId(sourceId)) {
    return { ok: false, reason: "already opened this M5" };
  }

  const primary = opts?.primary;
  if (primary && primary.length >= 12) {
    if (isExtendedChase(pred.side, primary)) {
      return {
        ok: false,
        reason: `chase block — ${pred.side} near 2h extreme, ±$2 too tight`,
      };
    }
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
