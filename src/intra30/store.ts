/**
 * Isolated Intra30 persistence.
 * Table `intra30_signals` — never the main `signals` table.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Intra30Signal } from "../strategies/intra30Engine";
import {
  INTRA30_SL_DISTANCE,
  INTRA30_TP_DISTANCE,
  INTRA30_TP2_DISTANCE,
} from "../strategies/intra30Engine";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = join(ROOT, "data");
export const LIVE_DB_PATH = join(DATA_DIR, "signals.db");
export const BACKTEST_DB_PATH = join(DATA_DIR, "backtest-results.db");

export type Intra30Outcome =
  | "OPEN"
  | "TP1_HIT"
  | "TP2_HIT"
  | "SL_HIT"
  | "INVALIDATED";

export interface Intra30Row {
  id: string;
  timestamp: number;
  symbol: string;
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  confidence: number;
  regime: string;
  outcome: Intra30Outcome;
  reason: string;
  dailyBias: string;
  strategy: "intra30";
  realizedR: number | null;
  resolvedAt: number | null;
  executedAt: number | null;
  source: "live" | "backtest";
  strongBarTime: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intra30_signals (
  id            TEXT PRIMARY KEY,
  timestamp     INTEGER NOT NULL,
  symbol        TEXT NOT NULL,
  direction     TEXT NOT NULL,
  entry         REAL NOT NULL,
  sl            REAL NOT NULL,
  tp1           REAL NOT NULL,
  tp2           REAL NOT NULL,
  confidence    REAL NOT NULL DEFAULT 0,
  regime        TEXT NOT NULL DEFAULT '',
  outcome       TEXT NOT NULL DEFAULT 'OPEN',
  reason        TEXT NOT NULL DEFAULT '[]',
  daily_bias    TEXT NOT NULL DEFAULT '',
  strategy      TEXT NOT NULL DEFAULT 'intra30',
  realized_r    REAL,
  resolved_at   INTEGER,
  executed_at   INTEGER,
  source        TEXT NOT NULL DEFAULT 'live',
  strong_bar_time INTEGER
);
CREATE INDEX IF NOT EXISTS idx_intra30_ts ON intra30_signals(timestamp);
CREATE INDEX IF NOT EXISTS idx_intra30_outcome ON intra30_signals(outcome);
`;

function ensureColumns(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(intra30_signals)`).all() as {
    name: string;
  }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("executed_at")) {
    db.exec(`ALTER TABLE intra30_signals ADD COLUMN executed_at INTEGER`);
  }
  if (!names.has("strong_bar_time")) {
    db.exec(`ALTER TABLE intra30_signals ADD COLUMN strong_bar_time INTEGER`);
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
  ensureColumns(db);
  return db;
}

export function getLiveIntra30Db(): Database.Database {
  if (liveDb) return liveDb;
  liveDb = openDb(LIVE_DB_PATH, 0x49333041); // 'I30A'
  return liveDb;
}

export function getBacktestIntra30Db(reset = false): Database.Database {
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
    const tmp = openDb(BACKTEST_DB_PATH, 0x49333042);
    tmp.exec("DROP TABLE IF EXISTS intra30_signals");
    tmp.close();
  }
  backtestDb = openDb(BACKTEST_DB_PATH, 0x49333042);
  return backtestDb;
}

function rowFromDb(r: Record<string, unknown>): Intra30Row {
  return {
    id: String(r.id),
    timestamp: Number(r.timestamp),
    symbol: String(r.symbol),
    direction: r.direction as "BUY" | "SELL",
    entry: Number(r.entry),
    sl: Number(r.sl),
    tp1: Number(r.tp1),
    tp2: Number(r.tp2),
    confidence: Number(r.confidence ?? 0),
    regime: String(r.regime ?? ""),
    outcome: r.outcome as Intra30Outcome,
    reason: String(r.reason ?? "[]"),
    dailyBias: String(r.daily_bias ?? ""),
    strategy: "intra30",
    realizedR: r.realized_r == null ? null : Number(r.realized_r),
    resolvedAt: r.resolved_at == null ? null : Number(r.resolved_at),
    executedAt: r.executed_at == null ? null : Number(r.executed_at),
    source: (r.source as "live" | "backtest") ?? "live",
    strongBarTime: r.strong_bar_time == null ? null : Number(r.strong_bar_time),
  };
}

export function signalToRow(
  sig: Intra30Signal,
  symbol: string,
  source: "live" | "backtest",
): Intra30Row {
  const timestamp = source === "live" ? Date.now() : sig.time;
  return {
    id: `intra30-${source}-${timestamp}-${sig.direction}-${sig.entry}`,
    timestamp,
    symbol,
    direction: sig.direction,
    entry: sig.entry,
    sl: sig.sl,
    tp1: sig.tp1,
    tp2: sig.tp2,
    confidence: sig.confidence,
    regime: sig.regime,
    outcome: "OPEN",
    reason: JSON.stringify(sig.reason),
    dailyBias: sig.dailyBias,
    strategy: "intra30",
    realizedR: null,
    resolvedAt: null,
    executedAt: null,
    source,
    strongBarTime: sig.strongBarTime,
  };
}

export function insertIntra30Row(db: Database.Database, row: Intra30Row): void {
  db.prepare(
    `INSERT OR IGNORE INTO intra30_signals
      (id, timestamp, symbol, direction, entry, sl, tp1, tp2, confidence, regime,
       outcome, reason, daily_bias, strategy, realized_r, resolved_at, executed_at, source, strong_bar_time)
     VALUES
      (@id, @timestamp, @symbol, @direction, @entry, @sl, @tp1, @tp2, @confidence, @regime,
       @outcome, @reason, @dailyBias, @strategy, @realizedR, @resolvedAt, @executedAt, @source, @strongBarTime)`,
  ).run(row);
}

export function markIntra30Executed(
  db: Database.Database,
  id: string,
  executedAt: number,
): void {
  db.prepare(
    `UPDATE intra30_signals
        SET executed_at = ?
      WHERE id = ? AND executed_at IS NULL`,
  ).run(executedAt, id);
}

export function updateIntra30Outcome(
  db: Database.Database,
  id: string,
  outcome: Intra30Outcome,
  realizedR: number,
  resolvedAt: number,
): void {
  db.prepare(
    `UPDATE intra30_signals
        SET outcome = ?, realized_r = ?, resolved_at = ?
      WHERE id = ?`,
  ).run(outcome, realizedR, resolvedAt, id);
}

/** Risk unit = SL ($3). TP1 = +1R, TP2 = +2R. */
export function intra30RealizedR(
  outcome: "TP1_HIT" | "TP2_HIT" | "SL_HIT",
): number {
  if (outcome === "SL_HIT") return -1;
  if (outcome === "TP2_HIT") {
    return INTRA30_TP2_DISTANCE / INTRA30_SL_DISTANCE;
  }
  return INTRA30_TP_DISTANCE / INTRA30_SL_DISTANCE;
}

export function hasIntra30StrongBar(
  db: Database.Database,
  strongBarTime: number,
): boolean {
  const r = db
    .prepare(
      `SELECT 1 AS ok FROM intra30_signals WHERE strong_bar_time = ? LIMIT 1`,
    )
    .get(strongBarTime) as { ok: number } | undefined;
  return Boolean(r);
}

export function getLatestIntra30(db: Database.Database): Intra30Row | null {
  const r = db
    .prepare(`SELECT * FROM intra30_signals ORDER BY timestamp DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  return r ? rowFromDb(r) : null;
}

export function getOpenOrLatestIntra30(db: Database.Database): Intra30Row | null {
  const open = db
    .prepare(
      `SELECT * FROM intra30_signals WHERE outcome = 'OPEN' ORDER BY timestamp DESC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  if (open) return rowFromDb(open);
  return getLatestIntra30(db);
}

/** All live OPEN rows (newest first) — multi-signal desk. */
export function listOpenIntra30(db: Database.Database): Intra30Row[] {
  const rows = db
    .prepare(
      `SELECT * FROM intra30_signals WHERE outcome = 'OPEN' ORDER BY timestamp DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowFromDb);
}

export function listIntra30Rows(db: Database.Database): Intra30Row[] {
  const rows = db
    .prepare(`SELECT * FROM intra30_signals ORDER BY timestamp ASC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowFromDb);
}

export function countResolvedIntra30(db: Database.Database): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM intra30_signals
        WHERE outcome IN ('TP1_HIT','TP2_HIT','SL_HIT')`,
    )
    .get() as { n: number };
  return r?.n ?? 0;
}

export function summarizeIntra30(db: Database.Database): {
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  maxDrawdownR: number | null;
} {
  const rows = listIntra30Rows(db).filter(
    (r) =>
      r.outcome === "TP1_HIT" ||
      r.outcome === "TP2_HIT" ||
      r.outcome === "SL_HIT",
  );
  const wins = rows.filter(
    (r) => r.outcome === "TP1_HIT" || r.outcome === "TP2_HIT",
  ).length;
  const losses = rows.filter((r) => r.outcome === "SL_HIT").length;
  const resolved = wins + losses;
  const rs = rows.map((r) => {
    if (r.realizedR != null) return r.realizedR;
    if (r.outcome === "SL_HIT") return -1;
    if (r.outcome === "TP2_HIT") {
      return INTRA30_TP2_DISTANCE / INTRA30_SL_DISTANCE;
    }
    return INTRA30_TP_DISTANCE / INTRA30_SL_DISTANCE;
  });
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

export function isIntra30BacktestValidated(summary: {
  resolved: number;
  winRate: number | null;
  avgR: number | null;
}): boolean {
  return (
    summary.resolved >= 50 &&
    summary.winRate != null &&
    summary.winRate >= 55 &&
    summary.avgR != null &&
    summary.avgR > 0
  );
}

export function assertIntra30DbPath(
  path: string,
  expect: "live" | "backtest",
): void {
  const p = resolve(path);
  if (expect === "live" && p !== resolve(LIVE_DB_PATH)) {
    throw new Error(`[intra30] expected live DB at ${LIVE_DB_PATH}, got ${p}`);
  }
  if (expect === "backtest" && p !== resolve(BACKTEST_DB_PATH)) {
    throw new Error(
      `[intra30] expected backtest DB at ${BACKTEST_DB_PATH}, got ${p}`,
    );
  }
}
