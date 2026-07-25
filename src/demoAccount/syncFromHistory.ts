/**
 * Mirror EXECUTED live module trades into the demo account (when autoFollow ON).
 * Positive-day desk: regime board + day stop/protect + sized risk.
 */
import { buildHistoryPayload, karachiYmd } from "../history/apiHistory";
import {
  evaluateDayRegime,
  setDayRegimeCache,
  type DayRegimeSnapshot,
} from "../regime/dayModuleRules";
import {
  DEMO_DAY_LOCK_R,
  DEMO_DAY_STOP_R,
  evaluateDemoFollowBudget,
} from "../regime/positiveDayDesk";
import {
  DEMO_STARTING_BALANCE,
  ensureDemoAccount,
  findDemoBySourceId,
  listOpenDemoPositions,
} from "./store";
import { closeFromSourceOutcome, takeDemoTrade } from "./engine";

export async function syncDemoFromHistory(opts?: {
  date?: string;
  /** Force take even if autoFollow is off (manual sync button). */
  force?: boolean;
}): Promise<{
  opened: number;
  closed: number;
  skipped: number;
  errors: string[];
  regime?: { date: string; lines: string[] };
  dayBudget?: { pnlUsd: number; netR: number; stopR: number; lockR: number };
}> {
  const acct = ensureDemoAccount();
  const date =
    opts?.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : karachiYmd();
  const hist = await buildHistoryPayload({ date, module: "all" });
  const regime: DayRegimeSnapshot = evaluateDayRegime(
    hist.trades,
    Date.now(),
    date,
  );
  setDayRegimeCache(regime);

  let opened = 0;
  let closed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const pos of listOpenDemoPositions()) {
    if (!pos.sourceId) continue;
    const trade = hist.trades.find((t) => t.id === pos.sourceId);
    if (!trade) continue;
    if (trade.outcome === "OPEN") continue;
    const res = closeFromSourceOutcome(
      pos.sourceId,
      trade.outcome,
      trade.realizedR,
    );
    if (res?.ok) closed += 1;
  }

  const follow = opts?.force === true || acct.autoFollow;
  if (!follow) {
    return { opened, closed, skipped, errors };
  }

  const bank =
    acct.startingBalance > 0 ? acct.startingBalance : DEMO_STARTING_BALANCE;
  const baseRisk = Math.round(((bank * acct.riskPct) / 100) * 100) / 100;
  let lastBudget = evaluateDemoFollowBudget("qs_pro", regime, acct);

  for (const t of hist.trades) {
    const budget = evaluateDemoFollowBudget(t.module, regime, acct);
    lastBudget = budget;
    if (!budget.ok) {
      skipped += 1;
      continue;
    }
    if (!t.executed) {
      skipped += 1;
      continue;
    }
    if (findDemoBySourceId(t.id)) {
      skipped += 1;
      continue;
    }

    const riskUsd =
      Math.round(baseRisk * budget.riskMult * 100) / 100;

    if (t.outcome !== "OPEN") {
      const take = takeDemoTrade({
        side: t.side,
        entry: t.entry,
        sl: t.sl,
        tp1: t.tp1,
        tp2: t.tp2,
        module: t.module,
        sourceId: t.id,
        riskUsd,
        note: `Auto ${t.moduleLabel} EXECUTED · x${budget.riskMult}`,
      });
      if (!take.ok) {
        if (!/pehle se|Duplicate/i.test(take.error)) errors.push(take.error);
        skipped += 1;
        continue;
      }
      opened += 1;
      const res = closeFromSourceOutcome(t.id, t.outcome, t.realizedR);
      if (res?.ok) closed += 1;
      continue;
    }

    const take = takeDemoTrade({
      side: t.side,
      entry: t.entry,
      sl: t.sl,
      tp1: t.tp1,
      tp2: t.tp2,
      module: t.module,
      sourceId: t.id,
      riskUsd,
      note: `Auto ${t.moduleLabel} EXECUTED (OPEN) · x${budget.riskMult}`,
    });
    if (!take.ok) {
      if (!/pehle se|Duplicate/i.test(take.error)) errors.push(take.error);
      skipped += 1;
      continue;
    }
    opened += 1;
  }

  return {
    opened,
    closed,
    skipped,
    errors,
    regime: {
      date: regime.date,
      lines: Object.values(regime.byModule).map(
        (r) =>
          `${r.module}:${r.tier} ${r.score.wins}W/${r.score.losses}L conf=${r.confidencePct ?? "pending"}% net=${r.score.netR}R demo=${r.allowDemoFollow ? "Y" : "N"} x${r.riskMult}`,
      ),
    },
    dayBudget: {
      pnlUsd: lastBudget.dayPnlUsd,
      netR: lastBudget.dayNetR,
      stopR: DEMO_DAY_STOP_R,
      lockR: DEMO_DAY_LOCK_R,
    },
  };
}
