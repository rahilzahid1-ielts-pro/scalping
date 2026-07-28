import { noteLearnResolved } from "./runtime";
import { sessionOf } from "./marketContext";
import type { LearnModule, LearnRow } from "./types";
import type { LoggedSignal } from "../calibration/types";
import { listAllSignals } from "../calibration/db";
import {
  getLiveQuickScalpDb,
  listQuickScalpRows,
} from "../quickScalp/store";
import { getLiveProDb, listProRows } from "../pro/store";
import { getLivePulseDb, listPulseRows } from "../pulse/store";
import { getLiveIntra30Db, listIntra30Rows } from "../intra30/store";
import {
  getLiveStrategyDb,
  listStrategyRows,
} from "../strategyCompare/store";

export type LearnResolvedOutcome = "TP1_HIT" | "TP2_HIT" | "SL_HIT";

export interface LiveResolvedTradeForLearn {
  id: string;
  module: LearnModule;
  moduleLabel?: string;
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  executedAt?: number | null;
  resolvedAt?: number | null;
  outcome: LearnResolvedOutcome;
  realizedR?: number | null;
  source?: string;
}

function finitePrice(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

export function noteResolvedTradeForLearn(input: LiveResolvedTradeForLearn): void {
  if (
    !finitePrice(input.entry) ||
    !finitePrice(input.sl) ||
    !finitePrice(input.tp1)
  ) {
    return;
  }
  const resolvedAt = input.resolvedAt ?? Date.now();
  const executedAt = input.executedAt ?? resolvedAt;
  const slMoney = Math.abs(input.entry - input.sl);
  const tp1Money = Math.abs(input.tp1 - input.entry);
  if (!(slMoney > 0) || !(tp1Money > 0)) return;

  const row: LearnRow = {
    id: input.id,
    module: input.module,
    moduleLabel: input.moduleLabel ?? input.module,
    side: input.side,
    entry: input.entry,
    sl: input.sl,
    tp1: input.tp1,
    slMoney,
    tp1Money,
    executedAt,
    resolvedAt,
    outcome: input.outcome,
    realizedR: input.realizedR ?? null,
    pnlMoney: null,
    source: input.source ?? "live",
    session: sessionOf(executedAt),
  };
  noteLearnResolved(row);
}

export function noteLoggedSignalForLearn(sig: LoggedSignal): void {
  if (sig.outcomeTp1 !== "WIN" && sig.outcomeTp1 !== "LOSS") return;
  noteResolvedTradeForLearn({
    id: sig.id,
    module: sig.mode === "intraday" ? "intraday" : "scalp",
    moduleLabel: sig.mode,
    side: sig.side,
    entry: sig.entry,
    sl: sig.sl,
    tp1: sig.tp1,
    executedAt: sig.zoneTouchedAt ?? sig.timestamp,
    resolvedAt: sig.resolvedAt ?? Date.now(),
    outcome: sig.outcomeTp1 === "WIN" ? "TP1_HIT" : "SL_HIT",
    realizedR: sig.realizedR,
    source: "live",
  });
}

type SeedLike = {
  id: string;
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  outcome: string;
  realizedR: number | null;
  resolvedAt: number | null;
  executedAt: number | null;
  timestamp?: number;
  time?: number;
};

/**
 * Cold-start fill for rolling recent[] from live DB rows so gateLearnedLock
 * has stack/after-TP context immediately after process boot (not only after
 * the next fresh resolve). Safe to call once at prodServer start.
 */
export function seedLearnRecentFromLiveDb(limit = 40): number {
  const rows: LiveResolvedTradeForLearn[] = [];

  try {
    for (const s of listAllSignals()) {
      if (s.outcomeTp1 !== "WIN" && s.outcomeTp1 !== "LOSS") continue;
      rows.push({
        id: s.id,
        module: s.mode === "intraday" ? "intraday" : "scalp",
        moduleLabel: s.mode,
        side: s.side,
        entry: s.entry,
        sl: s.sl,
        tp1: s.tp1,
        executedAt: s.zoneTouchedAt ?? s.timestamp,
        resolvedAt: s.resolvedAt,
        outcome: s.outcomeTp1 === "WIN" ? "TP1_HIT" : "SL_HIT",
        realizedR: s.realizedR,
        source: "live-seed",
      });
    }
  } catch {
    /* live DB may be unavailable in pure scripts */
  }

  const pushModule = (module: LearnModule, list: SeedLike[]) => {
    for (const r of list) {
      if (
        r.outcome !== "TP1_HIT" &&
        r.outcome !== "TP2_HIT" &&
        r.outcome !== "SL_HIT"
      ) {
        continue;
      }
      rows.push({
        id: r.id,
        module,
        side: r.direction,
        entry: r.entry,
        sl: r.sl,
        tp1: r.tp1,
        executedAt: r.executedAt ?? r.timestamp ?? r.time ?? r.resolvedAt,
        resolvedAt: r.resolvedAt,
        outcome: r.outcome as LearnResolvedOutcome,
        realizedR: r.realizedR,
        source: "live-seed",
      });
    }
  };

  try {
    pushModule("quick_scalp", listQuickScalpRows(getLiveQuickScalpDb()));
  } catch {
    /* ignore */
  }
  try {
    pushModule("pro", listProRows(getLiveProDb()));
  } catch {
    /* ignore */
  }
  try {
    pushModule("qs_pro", listPulseRows(getLivePulseDb()));
  } catch {
    /* ignore */
  }
  try {
    pushModule("intra30", listIntra30Rows(getLiveIntra30Db()));
  } catch {
    /* ignore */
  }
  try {
    const db = getLiveStrategyDb();
    pushModule(
      "cipher_b",
      listStrategyRows(db, "cipher_b_clone").map((r) => ({
        ...r,
        timestamp: r.time,
      })),
    );
    pushModule(
      "fractal",
      listStrategyRows(db, "fractal").map((r) => ({
        ...r,
        timestamp: r.time,
      })),
    );
  } catch {
    /* ignore */
  }

  rows.sort(
    (a, b) =>
      (a.resolvedAt ?? a.executedAt ?? 0) - (b.resolvedAt ?? b.executedAt ?? 0),
  );
  const slice = rows.slice(-Math.max(1, limit));
  for (const r of slice) noteResolvedTradeForLearn(r);
  return slice.length;
}
