/**
 * Read-only trade history across all live module tables.
 * Karachi calendar day filter — no engine / bot formula changes.
 */
import { listAllSignals } from "../calibration/db";
import { getLiveQuickScalpDb, listQuickScalpRows } from "../quickScalp/store";
import { getLiveProDb, listProRows } from "../pro/store";
import { getLiveIntra30Db, listIntra30Rows } from "../intra30/store";
import { getLivePulseDb, listPulseRows } from "../pulse/store";
import { getLiveStrategyDb, listStrategyRows } from "../strategyCompare/store";

const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

export type HistoryModuleId =
  | "scalp"
  | "intraday"
  | "quick_scalp"
  | "qs_pro"
  | "pro"
  | "intra30"
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
  /**
   * Money at risk to SL (XAUUSD: $ per oz = |entry−SL|).
   * Shown as negative risk for clarity in UI.
   */
  slMoney: number;
  /** Money to TP1 if hit ($ per oz = |TP1−entry|). */
  tp1Money: number;
  /** Money to TP2 if set ($ per oz). */
  tp2Money: number | null;
  /**
   * Realized P&L in $ when TP/SL resolved (per oz).
   * Null while OPEN / invalidated without R.
   */
  pnlMoney: number | null;
  /** Display / sort time — executed start when known, else lock time. */
  at: number;
  atKarachi: string;
  lockedAt: number;
  lockedAtKarachi: string;
  executed: boolean;
  executedAt: number | null;
  executedAtKarachi: string | null;
  executionLabel: "EXECUTED" | "NOT EXECUTED";
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
  intra30: "Intra30",
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
  if (outcome === "TP2_HIT") return "TP2 HIT";
  if (outcome === "TP1_HIT" || outcomeTp1 === "WIN") return "TP1 HIT";
  if (outcome === "SL_HIT" || outcomeTp1 === "LOSS") return "SL HIT";
  if (outcome === "OPEN") return "OPEN";
  if (outcome === "INVALIDATED") return "INVALIDATED";
  if (outcome === "REGIME_FLIP_INVALIDATED") return "REGIME FLIP";
  return outcome || "—";
}

function money2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** XAUUSD: $1 price move ≈ $1 / oz. */
function tradeMoneyLevels(
  entry: number,
  sl: number,
  tp1: number,
  tp2: number | null,
  outcome: string,
  realizedR: number | null,
): {
  slMoney: number;
  tp1Money: number;
  tp2Money: number | null;
  pnlMoney: number | null;
} {
  const slMoney = money2(Math.abs(entry - sl));
  const tp1Money = money2(Math.abs(tp1 - entry));
  const tp2Money =
    tp2 != null && Number.isFinite(tp2) ? money2(Math.abs(tp2 - entry)) : null;

  let pnlMoney: number | null = null;
  if (outcome === "SL_HIT") {
    pnlMoney =
      realizedR != null && Number.isFinite(realizedR)
        ? money2(slMoney * realizedR)
        : money2(-slMoney);
  } else if (outcome === "TP1_HIT" || outcome === "TP2_HIT") {
    if (realizedR != null && Number.isFinite(realizedR)) {
      pnlMoney = money2(slMoney * realizedR);
    } else if (outcome === "TP2_HIT" && tp2Money != null) {
      pnlMoney = money2(tp2Money);
    } else {
      pnlMoney = money2(tp1Money);
    }
  }

  return { slMoney, tp1Money, tp2Money, pnlMoney };
}

function fmtMoneySigned(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function describe(t: {
  moduleLabel: string;
  side: string;
  entry: number;
  sl: number;
  tp1: number;
  outcomeLabel: string;
  executionLabel: string;
  atKarachi: string;
  lockedAtKarachi: string;
  slMoney: number;
  tp1Money: number;
  pnlMoney: number | null;
}): string {
  const moneyBit =
    t.pnlMoney != null
      ? `P&L ${fmtMoneySigned(t.pnlMoney)}`
      : `SL ${fmtMoneySigned(-t.slMoney)} · TP1 ${fmtMoneySigned(t.tp1Money)}`;
  if (t.executionLabel === "NOT EXECUTED") {
    return `${t.moduleLabel} lock ${t.lockedAtKarachi} · ${t.side} @ ${t.entry.toFixed(2)} · SL ${t.sl.toFixed(2)} · TP1 ${t.tp1.toFixed(2)} · ${moneyBit} → NOT EXECUTED (entry wait)`;
  }
  return `${t.moduleLabel} EXECUTED ${t.atKarachi} · ${t.side} @ ${t.entry.toFixed(2)} · SL ${t.sl.toFixed(2)} · TP1 ${t.tp1.toFixed(2)} · ${moneyBit} → ${t.outcomeLabel}`;
}

/** Resolve execution state for History display. */
function executionOf(
  lockedAt: number,
  rawExecutedAt: number | null | undefined,
  outcome: string,
): { executed: boolean; executedAt: number | null; displayAt: number } {
  if (rawExecutedAt != null) {
    return { executed: true, executedAt: rawExecutedAt, displayAt: rawExecutedAt };
  }
  if (
    outcome === "OPEN" ||
    outcome === "INVALIDATED" ||
    outcome === "REGIME_FLIP_INVALIDATED"
  ) {
    return { executed: false, executedAt: null, displayAt: lockedAt };
  }
  // Legacy closed rows (pre-stamp): treat lock time as start.
  return { executed: true, executedAt: lockedAt, displayAt: lockedAt };
}

function isWin(outcome: string): boolean {
  return outcome === "TP1_HIT" || outcome === "TP2_HIT";
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
  partial: {
    id: string;
    module: HistoryModuleId;
    side: "BUY" | "SELL";
    entry: number;
    sl: number;
    tp1: number;
    tp2: number | null;
    outcome: string;
    outcomeTp1?: string | null;
    realizedR: number | null;
    lockedAt: number;
    executedAt?: number | null;
    resolvedAt: number | null;
  },
) {
  const outcomeLabelText = outcomeLabel(partial.outcome, partial.outcomeTp1);
  const ex = executionOf(partial.lockedAt, partial.executedAt, partial.outcome);
  const executionLabel: "EXECUTED" | "NOT EXECUTED" = ex.executed
    ? "EXECUTED"
    : "NOT EXECUTED";
  const atKarachi = formatKarachi(ex.displayAt);
  const lockedAtKarachi = formatKarachi(partial.lockedAt);
  const executedAtKarachi =
    ex.executedAt != null ? formatKarachi(ex.executedAt) : null;
  const resolvedKarachi =
    partial.resolvedAt != null ? formatKarachi(partial.resolvedAt) : null;
  const moduleLabel = LABELS[partial.module];
  const money = tradeMoneyLevels(
    partial.entry,
    partial.sl,
    partial.tp1,
    partial.tp2,
    partial.outcome,
    partial.realizedR,
  );
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
    slMoney: money.slMoney,
    tp1Money: money.tp1Money,
    tp2Money: money.tp2Money,
    pnlMoney: money.pnlMoney,
    at: ex.displayAt,
    atKarachi,
    lockedAt: partial.lockedAt,
    lockedAtKarachi,
    executed: ex.executed,
    executedAt: ex.executedAt,
    executedAtKarachi,
    executionLabel,
    resolvedAt: partial.resolvedAt,
    resolvedKarachi,
    description: describe({
      moduleLabel,
      side: partial.side,
      entry: partial.entry,
      sl: partial.sl,
      tp1: partial.tp1,
      outcomeLabel: outcomeLabelText,
      executionLabel,
      atKarachi,
      lockedAtKarachi,
      slMoney: money.slMoney,
      tp1Money: money.tp1Money,
      pnlMoney: money.pnlMoney,
    }),
  };
  all.push(row);
}

export async function buildHistoryPayload(opts: {
  date?: string | null;
  /** Inclusive range start (YYYY-MM-DD, Asia/Karachi). Overrides `date` when set with `to`. */
  from?: string | null;
  /** Inclusive range end (YYYY-MM-DD, Asia/Karachi). */
  to?: string | null;
  module?: string | null;
}): Promise<{
  ok: true;
  date: string;
  from: string;
  to: string;
  timezone: "Asia/Karachi";
  window: { start: number; end: number; startIso: string; endIso: string };
  moduleFilter: string;
  trades: HistoryTrade[];
  byModule: ModuleDayStats[];
  totals: ModuleDayStats;
}> {
  const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
  const today = karachiYmd();

  let from =
    opts.from && ymdRe.test(opts.from)
      ? opts.from
      : opts.date && ymdRe.test(opts.date)
        ? opts.date
        : today;
  let to =
    opts.to && ymdRe.test(opts.to)
      ? opts.to
      : opts.from && ymdRe.test(opts.from)
        ? opts.from
        : opts.date && ymdRe.test(opts.date)
          ? opts.date
          : today;

  if (from > to) {
    const tmp = from;
    from = to;
    to = tmp;
  }

  // Cap range at 90 Karachi days to keep payloads sane.
  const fromBound = karachiDayBounds(from);
  const toBound = karachiDayBounds(to);
  const maxSpanMs = 90 * 24 * 60 * 60 * 1000;
  if (toBound.end - fromBound.start > maxSpanMs) {
    // Keep `to`, pull `from` back 90 days.
    const clampedStart = toBound.end - maxSpanMs + 1;
    const d = new Date(clampedStart + 5 * 60 * 60 * 1000);
    from = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }

  const { start } = karachiDayBounds(from);
  const { end } = karachiDayBounds(to);
  const moduleFilter = (opts.module || "all").toLowerCase();
  const all: HistoryTrade[] = [];

  /** Still-OPEN always included when range covers today. */
  const rangeIncludesToday = from <= today && to >= today;
  const includeTrade = (
    lockedAt: number,
    executedAt: number | null | undefined,
    outcome: string,
  ) => {
    if (rangeIncludesToday && outcome === "OPEN") return true;
    if (inRange(lockedAt, start, end)) return true;
    if (executedAt != null && inRange(executedAt, start, end)) return true;
    return false;
  };

  const seen = new Set<string>();

  for (const s of safeCollect(() => listAllSignals())) {
    let outcome = s.outcome;
    if (s.outcomeTp1 === "WIN") outcome = "TP1_HIT";
    else if (s.outcomeTp1 === "LOSS") outcome = "SL_HIT";
    const executedAt = s.zoneTouchedAt ?? null;
    if (!includeTrade(s.timestamp, executedAt, outcome)) continue;
    const module: HistoryModuleId = s.mode === "intraday" ? "intraday" : "scalp";
    const id = s.id;
    if (seen.has(id)) continue;
    seen.add(id);
    pushTrade(all, {
      id,
      module,
      side: s.side,
      entry: s.entry,
      sl: s.sl,
      tp1: s.tp1,
      tp2: s.tp2,
      outcome,
      outcomeTp1: s.outcomeTp1,
      realizedR: s.realizedR,
      lockedAt: s.timestamp,
      executedAt,
      resolvedAt: s.resolvedAt,
    });
  }

  for (const r of safeCollect(() => listQuickScalpRows(getLiveQuickScalpDb()))) {
    if (!includeTrade(r.timestamp, r.executedAt, r.outcome)) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
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
      lockedAt: r.timestamp,
      executedAt: r.executedAt,
      resolvedAt: r.resolvedAt,
    });
  }

  for (const r of safeCollect(() => listPulseRows(getLivePulseDb()))) {
    if (!includeTrade(r.timestamp, r.executedAt, r.outcome)) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
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
      lockedAt: r.timestamp,
      executedAt: r.executedAt,
      resolvedAt: r.resolvedAt,
    });
  }

  for (const r of safeCollect(() => listProRows(getLiveProDb()))) {
    if (!includeTrade(r.timestamp, r.executedAt, r.outcome)) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
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
      lockedAt: r.timestamp,
      executedAt: r.executedAt,
      resolvedAt: r.resolvedAt,
    });
  }

  for (const r of safeCollect(() => listIntra30Rows(getLiveIntra30Db()))) {
    if (!includeTrade(r.timestamp, r.executedAt, r.outcome)) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    pushTrade(all, {
      id: r.id,
      module: "intra30",
      side: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      tp2: r.tp2,
      outcome: r.outcome,
      realizedR: r.realizedR,
      lockedAt: r.timestamp,
      executedAt: r.executedAt,
      resolvedAt: r.resolvedAt,
    });
  }

  for (const r of safeCollect(() => listStrategyRows(getLiveStrategyDb()))) {
    if (r.strategy !== "cipher_b_clone" && r.strategy !== "fractal") continue;
    if (!includeTrade(r.time, r.executedAt, r.outcome)) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
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
      lockedAt: r.time,
      executedAt: r.executedAt,
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
    "intra30",
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

  const dateLabel = from === to ? from : `${from} → ${to}`;

  return {
    ok: true,
    date: dateLabel,
    from,
    to,
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
