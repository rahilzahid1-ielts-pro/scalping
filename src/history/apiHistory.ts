/**
 * Read-only trade history across all live module tables.
 * Karachi calendar day filter — no engine / bot formula changes.
 */
import { listAllSignals } from "../calibration/db";
import { getLiveQuickScalpDb, listQuickScalpRows } from "../quickScalp/store";
import { getLiveProDb, listProRows } from "../pro/store";
import { getLivePulseDb, listPulseRows } from "../pulse/store";
import { getLiveStrategyDb, listStrategyRows } from "../strategyCompare/store";

const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

export type HistoryModuleId =
  | "scalp"
  | "intraday"
  | "quick_scalp"
  | "qs_pro"
  | "pro"
  | "cipher_b"
  | "fractal";

export interface HistoryTrade {
  id: string;
  module: HistoryModuleId;
  moduleLabel: string;
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number | null;
  outcome: string;
  outcomeLabel: string;
  realizedR: number | null;
  at: number;
  atKarachi: string;
  resolvedAt: number | null;
  resolvedKarachi: string | null;
  description: string;
}

export interface ModuleDayStats {
  module: HistoryModuleId;
  moduleLabel: string;
  trades: number;
  open: number;
  wins: number;
  losses: number;
  other: number;
  winRate: number | null;
  avgR: number | null;
}

const LABELS: Record<HistoryModuleId, string> = {
  scalp: "Scalp",
  intraday: "Intraday",
  quick_scalp: "Quick Scalp",
  qs_pro: "QS Pro",
  pro: "Pro",
  cipher_b: "Cipher B",
  fractal: "TTrades Fractal",
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function karachiYmd(ms = Date.now()): string {
  const d = new Date(ms + KARACHI_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function karachiDayBounds(ymd: string): { start: number; end: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) throw new Error(`Invalid date (use YYYY-MM-DD): ${ymd}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const start = Date.UTC(y, mo - 1, d, 0, 0, 0) - KARACHI_OFFSET_MS;
  const end = start + 24 * 60 * 60 * 1000 - 1;
  return { start, end };
}

export function formatKarachi(ms: number): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Karachi",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(ms));
  } catch {
    const d = new Date(ms + KARACHI_OFFSET_MS);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} PKT`;
  }
}

function outcomeLabel(outcome: string, outcomeTp1?: string | null): string {
  if (outcome === "TP1_HIT" || outcomeTp1 === "WIN") return "TP1 HIT";
  if (outcome === "SL_HIT" || outcomeTp1 === "LOSS") return "SL HIT";
  if (outcome === "OPEN") return "OPEN";
  if (outcome === "INVALIDATED") return "INVALIDATED";
  if (outcome === "REGIME_FLIP_INVALIDATED") return "REGIME FLIP";
  return outcome || "—";
}

function describe(t: {
  moduleLabel: string;
  side: string;
  entry: number;
  sl: number;
  tp1: number;
  outcomeLabel: string;
  atKarachi: string;
}): string {
  return `${t.moduleLabel} ne ${t.atKarachi} pe ${t.side} diya @ ${t.entry.toFixed(2)} · SL ${t.sl.toFixed(2)} · TP1 ${t.tp1.toFixed(2)} → ${t.outcomeLabel}`;
}

function isWin(outcome: string): boolean {
  return outcome === "TP1_HIT";
}
function isLoss(outcome: string): boolean {
  return outcome === "SL_HIT";
}
function inRange(t: number, start: number, end: number): boolean {
  return t >= start && t <= end;
}

function summarize(module: HistoryModuleId, trades: HistoryTrade[]): ModuleDayStats {
  const open = trades.filter((t) => t.outcome === "OPEN").length;
  const wins = trades.filter((t) => isWin(t.outcome)).length;
  const losses = trades.filter((t) => isLoss(t.outcome)).length;
  const other = trades.length - open - wins - losses;
  const resolved = wins + losses;
  const rs = trades
    .filter((t) => isWin(t.outcome) || isLoss(t.outcome))
    .map((t) => t.realizedR ?? (isWin(t.outcome) ? 1 : -1));
  return {
    module,
    moduleLabel: LABELS[module],
    trades: trades.length,
    open,
    wins,
    losses,
    other,
    winRate: resolved > 0 ? (wins / resolved) * 100 : null,
    avgR: resolved > 0 ? rs.reduce((a, b) => a + b, 0) / resolved : null,
  };
}

function safeCollect<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

function pushTrade(
  all: HistoryTrade[],
  partial: Omit<HistoryTrade, "atKarachi" | "resolvedKarachi" | "outcomeLabel" | "description" | "moduleLabel"> & {
    module: HistoryModuleId;
    outcomeTp1?: string | null;
  },
) {
  const outcomeLabelText = outcomeLabel(partial.outcome, partial.outcomeTp1);
  const atKarachi = formatKarachi(partial.at);
  const resolvedKarachi =
    partial.resolvedAt != null ? formatKarachi(partial.resolvedAt) : null;
  const moduleLabel = LABELS[partial.module];
  const row: HistoryTrade = {
    id: partial.id,
    module: partial.module,
    moduleLabel,
    side: partial.side,
    entry: partial.entry,
    sl: partial.sl,
    tp1: partial.tp1,
    tp2: partial.tp2,
    outcome: partial.outcome,
    outcomeLabel: outcomeLabelText,
    realizedR: partial.realizedR,
    at: partial.at,
    atKarachi,
    resolvedAt: partial.resolvedAt,
    resolvedKarachi,
    description: describe({
      moduleLabel,
      side: partial.side,
      entry: partial.entry,
      sl: partial.sl,
      tp1: partial.tp1,
      outcomeLabel: outcomeLabelText,
      atKarachi,
    }),
  };
  all.push(row);
}

export async function buildHistoryPayload(opts: {
  date?: string | null;
  module?: string | null;
}): Promise<{
  ok: true;
  date: string;
  timezone: "Asia/Karachi";
  window: { start: number; end: number; startIso: string; endIso: string };
  moduleFilter: string;
  trades: HistoryTrade[];
  byModule: ModuleDayStats[];
  totals: ModuleDayStats;
}> {
  const date = opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date) ? opts.date : karachiYmd();
  const { start, end } = karachiDayBounds(date);
  const moduleFilter = (opts.module || "all").toLowerCase();
  const all: HistoryTrade[] = [];

  for (const s of safeCollect(() => listAllSignals())) {
    if (!inRange(s.timestamp, start, end)) continue;
    const module: HistoryModuleId = s.mode === "intraday" ? "intraday" : "scalp";
    let outcome = s.outcome;
    if (s.outcomeTp1 === "WIN") outcome = "TP1_HIT";
    else if (s.outcomeTp1 === "LOSS") outcome = "SL_HIT";
    pushTrade(all, {
      id: s.id,
      module,
      side: s.side,
      entry: s.entry,
      sl: s.sl,
      tp1: s.tp1,
      tp2: s.tp2,
      outcome,
      outcomeTp1: s.outcomeTp1,
      realizedR: s.realizedR,
      at: s.timestamp,
      resolvedAt: s.resolvedAt,
    });
  }

  for (const r of safeCollect(() => listQuickScalpRows(getLiveQuickScalpDb()))) {
    if (!inRange(r.timestamp, start, end)) continue;
    pushTrade(all, {
      id: r.id,
      module: "quick_scalp",
      side: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      tp2: r.tp2,
      outcome: r.outcome,
      realizedR: r.realizedR,
      at: r.timestamp,
      resolvedAt: r.resolvedAt,
    });
  }

  for (const r of safeCollect(() => listPulseRows(getLivePulseDb()))) {
    if (!inRange(r.timestamp, start, end)) continue;
    pushTrade(all, {
      id: r.id,
      module: "qs_pro",
      side: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      tp2: r.tp2,
      outcome: r.outcome,
      realizedR: r.realizedR,
      at: r.timestamp,
      resolvedAt: r.resolvedAt,
    });
  }

  for (const r of safeCollect(() => listProRows(getLiveProDb()))) {
    if (!inRange(r.timestamp, start, end)) continue;
    pushTrade(all, {
      id: r.id,
      module: "pro",
      side: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      tp2: r.tp2,
      outcome: r.outcome,
      realizedR: r.realizedR,
      at: r.timestamp,
      resolvedAt: r.resolvedAt,
    });
  }

  for (const r of safeCollect(() => listStrategyRows(getLiveStrategyDb()))) {
    if (r.strategy !== "cipher_b_clone" && r.strategy !== "fractal") continue;
    if (!inRange(r.time, start, end)) continue;
    const module: HistoryModuleId = r.strategy === "fractal" ? "fractal" : "cipher_b";
    pushTrade(all, {
      id: r.id,
      module,
      side: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      tp2: r.tp2,
      outcome: r.outcome,
      realizedR: r.realizedR,
      at: r.time,
      resolvedAt: r.resolvedAt,
    });
  }

  all.sort((a, b) => b.at - a.at);

  const filtered =
    moduleFilter === "all"
      ? all
      : all.filter((t) => t.module === moduleFilter);

  const modules: HistoryModuleId[] = [
    "scalp",
    "intraday",
    "quick_scalp",
    "qs_pro",
    "pro",
    "cipher_b",
    "fractal",
  ];
  const byModule = modules
    .map((m) => summarize(m, all.filter((t) => t.module === m)))
    .filter((s) => s.trades > 0);

  const tWins = filtered.filter((t) => isWin(t.outcome)).length;
  const tLosses = filtered.filter((t) => isLoss(t.outcome)).length;
  const tOpen = filtered.filter((t) => t.outcome === "OPEN").length;
  const tResolved = tWins + tLosses;
  const tRs = filtered
    .filter((t) => isWin(t.outcome) || isLoss(t.outcome))
    .map((t) => t.realizedR ?? (isWin(t.outcome) ? 1 : -1));

  return {
    ok: true,
    date,
    timezone: "Asia/Karachi",
    window: {
      start,
      end,
      startIso: new Date(start).toISOString(),
      endIso: new Date(end).toISOString(),
    },
    moduleFilter,
    trades: filtered,
    byModule,
    totals: {
      module: "scalp",
      moduleLabel:
        moduleFilter === "all"
          ? "All modules"
          : (LABELS[moduleFilter as HistoryModuleId] ?? moduleFilter),
      trades: filtered.length,
      open: tOpen,
      wins: tWins,
      losses: tLosses,
      other: filtered.length - tOpen - tWins - tLosses,
      winRate: tResolved > 0 ? (tWins / tResolved) * 100 : null,
      avgR: tResolved > 0 ? tRs.reduce((a, b) => a + b, 0) / tResolved : null,
    },
  };
}
