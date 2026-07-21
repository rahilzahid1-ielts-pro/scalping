/**
 * Isolated Quick Scalp persistence.
 * Uses a SEPARATE table `quick_scalp_signals` — never the main `signals` table.
 * Live: data/signals.db (same file, different table)
 * Backtest: data/backtest-results.db (same file, different table)
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { QuickScalpSignal } from "../strategies/quickScalpEngine";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = join(ROOT, "data");
export const LIVE_DB_PATH = join(DATA_DIR, "signals.db");
export const BACKTEST_DB_PATH = join(DATA_DIR, "backtest-results.db");

export type QuickScalpOutcome = "OPEN" | "TP1_HIT" | "SL_HIT" | "INVALIDATED";

export interface QuickScalpRow {
  id: string;
  timestamp: number;
  symbol: string;
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  outcome: QuickScalpOutcome;
  reason: string;
  dailyTrend: string;
  strategy: "quick_scalp";
  realizedR: number | null;
  resolvedAt: number | null;
  /** When price first hit entry — null until trade actually starts. */
  executedAt: number | null;
  source: "live" | "backtest";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quick_scalp_signals (
  id            TEXT PRIMARY KEY,
  timestamp     INTEGER NOT NULL,
  symbol        TEXT NOT NULL,
  direction     TEXT NOT NULL,
  entry         REAL NOT NULL,
  sl            REAL NOT NULL,
  tp1           REAL NOT NULL,
  tp2           REAL NOT NULL,
  outcome       TEXT NOT NULL DEFAULT 'OPEN',
  reason        TEXT NOT NULL DEFAULT '[]',
  daily_trend   TEXT NOT NULL DEFAULT '',
  strategy      TEXT NOT NULL DEFAULT 'quick_scalp',
  realized_r    REAL,
  resolved_at   INTEGER,
  executed_at   INTEGER,
  source        TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_qs_ts ON quick_scalp_signals(timestamp);
CREATE INDEX IF NOT EXISTS idx_qs_outcome ON quick_scalp_signals(outcome);
`;

function ensureExecutedAtColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(quick_scalp_signals)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "executed_at")) {
    db.exec(`ALTER TABLE quick_scalp_signals ADD COLUMN executed_at INTEGER`);
  }
}

let liveDb: Database.Database | null = null;
let backtestDb: Database.Database | null = null;

function openDb(path: string, tag: number): Database.Database {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma(`application_id = ${tag}`);
  db.exec(SCHEMA);
  ensureExecutedAtColumn(db);
  return db;
}

export function getLiveQuickScalpDb(): Database.Database {
  if (liveDb) return liveDb;
  // Same file as live calibration DB, but we ONLY touch quick_scalp_signals.
  liveDb = openDb(LIVE_DB_PATH, 0x51534341); // 'QSCA'
  return liveDb;
}

export function getBacktestQuickScalpDb(reset = false): Database.Database {
  if (backtestDb && !reset) return backtestDb;
  if (backtestDb) {
    try {
      backtestDb.close();
    } catch {
      /* ignore */
    }
    backtestDb = null;
  }
  if (reset && existsSync(BACKTEST_DB_PATH)) {
    // Only drop our isolated table — never the main backtest `signals` table.
    const tmp = openDb(BACKTEST_DB_PATH, 0x51534342);
    tmp.exec("DROP TABLE IF EXISTS quick_scalp_signals");
    tmp.close();
  }
  backtestDb = openDb(BACKTEST_DB_PATH, 0x51534342);
  return backtestDb;
}

function rowFromDb(r: Record<string, unknown>): QuickScalpRow {
  return {
    id: String(r.id),
    timestamp: Number(r.timestamp),
    symbol: String(r.symbol),
    direction: r.direction as "BUY" | "SELL",
    entry: Number(r.entry),
    sl: Number(r.sl),
    tp1: Number(r.tp1),
    tp2: Number(r.tp2),
    outcome: r.outcome as QuickScalpOutcome,
    reason: String(r.reason ?? "[]"),
    dailyTrend: String(r.daily_trend ?? ""),
    strategy: "quick_scalp",
    realizedR: r.realized_r == null ? null : Number(r.realized_r),
    resolvedAt: r.resolved_at == null ? null : Number(r.resolved_at),
    executedAt: r.executed_at == null ? null : Number(r.executed_at),
    source: (r.source as "live" | "backtest") ?? "live",
  };
}

export function signalToRow(
  sig: QuickScalpSignal,
  symbol: string,
  source: "live" | "backtest",
): QuickScalpRow {
  const timestamp = source === "live" ? Date.now() : sig.time;
  return {
    id: `qs-${source}-${timestamp}-${sig.direction}-${sig.entry}`,
    timestamp,
    symbol,
    direction: sig.direction,
    entry: sig.entry,
    sl: sig.sl,
    tp1: sig.tp1,
    tp2: sig.tp2,
    outcome: "OPEN",
    reason: JSON.stringify(sig.reason),
    dailyTrend: sig.dailyTrend,
    strategy: "quick_scalp",
    realizedR: null,
    resolvedAt: null,
    executedAt: null,
    source,
  };
}

export function insertQuickScalpRow(db: Database.Database, row: QuickScalpRow): void {
  db.prepare(
    `INSERT OR IGNORE INTO quick_scalp_signals
      (id, timestamp, symbol, direction, entry, sl, tp1, tp2, outcome, reason,
       daily_trend, strategy, realized_r, resolved_at, executed_at, source)
     VALUES
      (@id, @timestamp, @symbol, @direction, @entry, @sl, @tp1, @tp2, @outcome, @reason,
       @dailyTrend, @strategy, @realizedR, @resolvedAt, @executedAt, @source)`,
  ).run(row);
}

export function markQuickScalpExecuted(
  db: Database.Database,
  id: string,
  executedAt: number,
): void {
  db.prepare(
    `UPDATE quick_scalp_signals
        SET executed_at = ?
      WHERE id = ? AND executed_at IS NULL`,
  ).run(executedAt, id);
}

export function updateQuickScalpOutcome(
  db: Database.Database,
  id: string,
  outcome: QuickScalpOutcome,
  realizedR: number,
  resolvedAt: number,
): void {
  db.prepare(
    `UPDATE quick_scalp_signals
        SET outcome = ?, realized_r = ?, resolved_at = ?
      WHERE id = ?`,
  ).run(outcome, realizedR, resolvedAt, id);
}

export function getLatestQuickScalp(db: Database.Database): QuickScalpRow | null {
  const r = db
    .prepare(`SELECT * FROM quick_scalp_signals ORDER BY timestamp DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  return r ? rowFromDb(r) : null;
}

/** Prefer OPEN (active trade) so UI does not jump to WAIT after redeploy. */
export function getOpenOrLatestQuickScalp(db: Database.Database): QuickScalpRow | null {
  const open = db
    .prepare(
      `SELECT * FROM quick_scalp_signals WHERE outcome = 'OPEN' ORDER BY timestamp DESC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  if (open) return rowFromDb(open);
  return getLatestQuickScalp(db);
}

export function listQuickScalpRows(db: Database.Database): QuickScalpRow[] {
  const rows = db
    .prepare(`SELECT * FROM quick_scalp_signals ORDER BY timestamp ASC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowFromDb);
}

export function countResolvedQuickScalp(db: Database.Database): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM quick_scalp_signals
        WHERE outcome IN ('TP1_HIT','SL_HIT')`,
    )
    .get() as { n: number };
  return r?.n ?? 0;
}

/** Summarize resolved Quick Scalp trades for UI badge / API (no invented confidence). */
export function summarizeQuickScalp(db: Database.Database): {
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  maxDrawdownR: number | null;
} {
  const rows = listQuickScalpRows(db).filter(
    (r) => r.outcome === "TP1_HIT" || r.outcome === "SL_HIT",
  );
  const wins = rows.filter((r) => r.outcome === "TP1_HIT").length;
  const losses = rows.filter((r) => r.outcome === "SL_HIT").length;
  const resolved = wins + losses;
  const rs = rows.map((r) => r.realizedR ?? (r.outcome === "TP1_HIT" ? 1 : -1));
  const avgR = resolved > 0 ? rs.reduce((a, b) => a + b, 0) / resolved : null;

  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    maxDd = Math.min(maxDd, equity - peak);
  }

  return {
    resolved,
    wins,
    losses,
    winRate: resolved > 0 ? (wins / resolved) * 100 : null,
    avgR,
    maxDrawdownR: resolved > 0 ? maxDd : null,
  };
}

/** Guard: never confuse paths. */
export function assertQuickScalpDbPath(path: string, expect: "live" | "backtest"): void {
  const p = resolve(path);
  if (expect === "live" && p !== resolve(LIVE_DB_PATH)) {
    throw new Error(`[quickScalp] expected live DB at ${LIVE_DB_PATH}, got ${p}`);
  }
  if (expect === "backtest" && p !== resolve(BACKTEST_DB_PATH)) {
    throw new Error(`[quickScalp] expected backtest DB at ${BACKTEST_DB_PATH}, got ${p}`);
  }
}
