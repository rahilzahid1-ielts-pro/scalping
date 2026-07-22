/**
 * Single source of truth for what History shows as the active lock.
 * Used by module latest APIs and exit-advisory so screens never disagree with History.
 * Server-only — do not import from browser UI (pulls better-sqlite3).
 */
import { listOpenSignals } from "../calibration/resolveOutcomes";
import { getLiveQuickScalpDb, listQuickScalpRows } from "../quickScalp/store";
import { getLiveProDb, listProRows } from "../pro/store";
import { getLiveIntra30Db, listIntra30Rows } from "../intra30/store";
import { getLivePulseDb, listPulseRows } from "../pulse/store";
import { getLiveStrategyDb, listStrategyRows } from "../strategyCompare/store";
import {
  historyModuleToActiveId,
  type ActiveModuleId,
} from "./moduleIds";

export type { ActiveModuleId };
export { historyModuleToActiveId };

export interface ActiveOpenLock {
  module: ActiveModuleId;
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  outcome: "OPEN";
  time: number;
  /** When price first hit entry (null = not executed yet). */
  executedAt?: number | null;
  reason: string;
  confidence?: number;
  dailyBias?: string;
  regime?: string;
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Most recent OPEN lock for a module — same rows History lists. */
export function getActiveOpenLock(module: ActiveModuleId): ActiveOpenLock | null {
  if (module === "scalp" || module === "intraday") {
    const mode = module === "intraday" ? "intraday" : "scalping";
    const opens = safe(() =>
      listOpenSignals().filter(
        (s) =>
          s.symbol === "XAUUSD" &&
          s.mode === mode &&
          s.outcome === "OPEN" &&
          (s.side === "BUY" || s.side === "SELL"),
      ),
    );
    if (!opens?.length) return null;
    const s = opens.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b));
    return {
      module,
      direction: s.side,
      entry: s.entry,
      sl: s.sl,
      tp1: s.tp1,
      tp2: s.tp2,
      outcome: "OPEN",
      time: s.timestamp,
      executedAt: s.zoneTouchedAt ?? null,
      reason: JSON.stringify([`History OPEN · ${module}`]),
      confidence: s.confidence,
      dailyBias: s.dailyBias,
      regime: s.regime ?? undefined,
    };
  }

  if (module === "quick_scalp") {
    const rows = safe(() =>
      listQuickScalpRows(getLiveQuickScalpDb()).filter((r) => r.outcome === "OPEN"),
    );
    if (!rows?.length) return null;
    const r = rows.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b));
    return {
      module,
      direction: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      tp2: r.tp2,
      outcome: "OPEN",
      time: r.timestamp,
      executedAt: r.executedAt ?? null,
      reason: r.reason,
      dailyBias: r.dailyTrend,
    };
  }

  if (module === "pro") {
    const rows = safe(() =>
      listProRows(getLiveProDb()).filter((r) => r.outcome === "OPEN"),
    );
    if (!rows?.length) return null;
    const r = rows.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b));
    return {
      module,
      direction: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      tp2: r.tp2,
      outcome: "OPEN",
      time: r.timestamp,
      executedAt: r.executedAt ?? null,
      reason: r.reason,
      confidence: r.confidence,
      dailyBias: r.dailyBias,
      regime: r.regime,
    };
  }

  if (module === "intra30") {
    const rows = safe(() =>
      listIntra30Rows(getLiveIntra30Db()).filter((r) => r.outcome === "OPEN"),
    );
    if (!rows?.length) return null;
    const r = rows.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b));
    return {
      module,
      direction: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      tp2: r.tp2,
      outcome: "OPEN",
      time: r.timestamp,
      executedAt: r.executedAt ?? null,
      reason: r.reason,
      confidence: r.confidence,
      dailyBias: r.dailyBias,
      regime: r.regime,
    };
  }

  if (module === "qs_pro") {
    const rows = safe(() =>
      listPulseRows(getLivePulseDb()).filter((r) => r.outcome === "OPEN"),
    );
    if (!rows?.length) return null;
    const r = rows.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b));
    return {
      module,
      direction: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      tp2: r.tp2,
      outcome: "OPEN",
      time: r.timestamp,
      executedAt: r.executedAt ?? null,
      reason: r.reason,
      confidence: r.confidence,
      dailyBias: r.dailyBias,
      regime: r.regime,
    };
  }

  if (module === "cipher_b" || module === "fractal") {
    const strategy = module === "fractal" ? "fractal" : "cipher_b_clone";
    const rows = safe(() =>
      listStrategyRows(getLiveStrategyDb(), strategy).filter((r) => r.outcome === "OPEN"),
    );
    if (!rows?.length) return null;
    const r = rows.reduce((a, b) => (a.time >= b.time ? a : b));
    return {
      module,
      direction: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      tp2: r.tp2,
      outcome: "OPEN",
      time: r.time,
      executedAt: r.executedAt ?? null,
      reason: r.reason,
    };
  }

  return null;
}
