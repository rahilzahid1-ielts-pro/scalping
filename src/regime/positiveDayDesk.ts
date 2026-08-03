/**
 * Positive-day desk — demo equity guardrails.
 * Goal: green days with real fills (not silence). Hard stop red days; protect greens.
 *
 * No ML yet — rules from Jul 22–24 loss autopsy + Cipher/QS Pro backtests.
 */
import { karachiDayBounds, karachiYmd } from "../history/apiHistory";
import {
  DEMO_ACCOUNT_ID,
  DEMO_STARTING_BALANCE,
  ensureDemoAccount,
  getDemoDb,
  type DemoAccountRow,
} from "../demoAccount/store";
import {
  demoRiskMultForModule,
  isPreferModule,
  shouldDemoFollowModule,
  type DayRegimeSnapshot,
} from "./dayModuleRules";

/** Stop new auto-follows after this closed-day R (protect capital). */
export const DEMO_DAY_STOP_R = -3;
/** After this green R, only prefer modules (bank the day). */
export const DEMO_DAY_PROTECT_R = 3;
/** After this green R, stop new follows (day done — keep profit). */
export const DEMO_DAY_LOCK_R = 5;

export type DemoDayBudget = {
  ok: boolean;
  reason: string;
  dayPnlUsd: number;
  dayNetR: number;
  riskUnit: number;
  riskMult: number;
};

export function demoDayClosedPnl(
  date = karachiYmd(),
  opts?: { excludeModules?: string[] },
): {
  pnlUsd: number;
  closed: number;
} {
  const db = getDemoDb();
  ensureDemoAccount();
  const { start, end } = karachiDayBounds(date);
  const exclude = (opts?.excludeModules ?? [])
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);

  let sql = `SELECT COALESCE(SUM(pnl_usd), 0) AS pnl, COUNT(*) AS n
       FROM demo_positions
       WHERE account_id = ?
         AND status = 'CLOSED'
         AND closed_at IS NOT NULL
         AND closed_at >= ? AND closed_at <= ?
         AND (note IS NULL OR note NOT LIKE '%VOID quote-spike%')`;
  const params: (string | number)[] = [DEMO_ACCOUNT_ID, start, end];
  if (exclude.length) {
    sql += ` AND lower(module) NOT IN (${exclude.map(() => "?").join(",")})`;
    params.push(...exclude);
  }
  const row = db.prepare(sql).get(...params) as { pnl: number; n: number };
  return {
    pnlUsd: Math.round(Number(row.pnl || 0) * 100) / 100,
    closed: Number(row.n || 0),
  };
}

function riskUnitUsd(acct: DemoAccountRow): number {
  const bank =
    acct.startingBalance > 0 ? acct.startingBalance : DEMO_STARTING_BALANCE;
  return Math.round(((bank * acct.riskPct) / 100) * 100) / 100;
}

/**
 * Should demo open this module now, and at what risk multiplier?
 * Combines regime allow + day stop / profit protect.
 */
export function evaluateDemoFollowBudget(
  module: string,
  snap: DayRegimeSnapshot,
  acct?: DemoAccountRow,
): DemoDayBudget {
  const account = acct ?? ensureDemoAccount();
  const unit = riskUnitUsd(account);
  // Probeb is its own ±$2 desk — fake/stack PnL must not day-lock QS Pro / Cipher.
  const { pnlUsd } = demoDayClosedPnl(snap.date, {
    excludeModules: ["probeb"],
  });
  const dayNetR = unit > 0 ? Math.round((pnlUsd / unit) * 1000) / 1000 : 0;
  const baseMult = demoRiskMultForModule(module, snap);

  if (!shouldDemoFollowModule(module, snap)) {
    return {
      ok: false,
      reason: "regime: module not on demo board",
      dayPnlUsd: pnlUsd,
      dayNetR,
      riskUnit: unit,
      riskMult: 0,
    };
  }

  if (dayNetR <= DEMO_DAY_STOP_R) {
    return {
      ok: false,
      reason: `day stop ${dayNetR}R ≤ ${DEMO_DAY_STOP_R}R — no new auto follows`,
      dayPnlUsd: pnlUsd,
      dayNetR,
      riskUnit: unit,
      riskMult: 0,
    };
  }

  if (dayNetR >= DEMO_DAY_LOCK_R) {
    return {
      ok: false,
      reason: `day lock ${dayNetR}R ≥ ${DEMO_DAY_LOCK_R}R — bank the green`,
      dayPnlUsd: pnlUsd,
      dayNetR,
      riskUnit: unit,
      riskMult: 0,
    };
  }

  let riskMult = baseMult;
  if (dayNetR >= DEMO_DAY_PROTECT_R) {
    if (!isPreferModule(module)) {
      return {
        ok: false,
        reason: `day protect ${dayNetR}R — only prefer modules`,
        dayPnlUsd: pnlUsd,
        dayNetR,
        riskUnit: unit,
        riskMult: 0,
      };
    }
    riskMult = Math.min(riskMult, 0.75);
  }

  if (!(riskMult > 0)) {
    return {
      ok: false,
      reason: "risk mult 0",
      dayPnlUsd: pnlUsd,
      dayNetR,
      riskUnit: unit,
      riskMult: 0,
    };
  }

  return {
    ok: true,
    reason: "ok",
    dayPnlUsd: pnlUsd,
    dayNetR,
    riskUnit: unit,
    riskMult,
  };
}
