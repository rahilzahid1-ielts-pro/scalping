/**
 * Isolated Pro persistence.
 * Table `pro_signals` — never the main `signals` table.
 * Live: data/signals.db | Backtest: data/backtest-results.db
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProSignal } from "../strategies/proEngine";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = join(ROOT, "data");
export const LIVE_DB_PATH = join(DATA_DIR, "signals.db");
export const BACKTEST_DB_PATH = join(DATA_DIR, "backtest-results.db");

export type ProOutcome = "OPEN" | "TP1_HIT" | "SL_HIT" | "INVALIDATED";

export interface ProRow {
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
  outcome: ProOutcome;
  reason: string;
  dailyBias: string;
  strategy: "pro";
  realizedR: number | null;
  resolvedAt: number | null;
  /** When price first hit entry — null until trade actually starts. */
  executedAt: number | null;
  source: "live" | "backtest";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pro_signals (
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
  strategy      TEXT NOT NULL DEFAULT 'pro',
  realized_r    REAL,
  resolved_at   INTEGER,
  executed_at   INTEGER,
  source        TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_pro_ts ON pro_signals(timestamp);
CREATE INDEX IF NOT EXISTS idx_pro_outcome ON pro_signals(outcome);
`;

function ensureExecutedAtColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(pro_signals)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "executed_at")) {
    db.exec(`ALTER TABLE pro_signals ADD COLUMN executed_at INTEGER`);
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

export function getLiveProDb(): Database.Database {
  if (liveDb) return liveDb;
  liveDb = openDb(LIVE_DB_PATH, 0x50524f41); // 'PROA'
  return liveDb;
}

export function getBacktestProDb(reset = false): Database.Database {
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
    const tmp = openDb(BACKTEST_DB_PATH, 0x50524f42);
    tmp.exec("DROP TABLE IF EXISTS pro_signals");
    tmp.close();
  }
  backtestDb = openDb(BACKTEST_DB_PATH, 0x50524f42);
  return backtestDb;
}

function rowFromDb(r: Record<string, unknown>): ProRow {
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
    outcome: r.outcome as ProOutcome,
    reason: String(r.reason ?? "[]"),
    dailyBias: String(r.daily_bias ?? ""),
    strategy: "pro",
    realizedR: r.realized_r == null ? null : Number(r.realized_r),
    resolvedAt: r.resolved_at == null ? null : Number(r.resolved_at),
    executedAt: r.executed_at == null ? null : Number(r.executed_at),
    source: (r.source as "live" | "backtest") ?? "live",
  };
}

export function signalToRow(
  sig: ProSignal,
  symbol: string,
  source: "live" | "backtest",
): ProRow {
  const timestamp = source === "live" ? Date.now() : sig.time;
  return {
    id: `pro-${source}-${timestamp}-${sig.direction}-${sig.entry}`,
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
    strategy: "pro",
    realizedR: null,
    resolvedAt: null,
    executedAt: null,
    source,
  };
}

export function insertProRow(db: Database.Database, row: ProRow): void {
  db.prepare(
    `INSERT OR IGNORE INTO pro_signals
      (id, timestamp, symbol, direction, entry, sl, tp1, tp2, confidence, regime,
       outcome, reason, daily_bias, strategy, realized_r, resolved_at, executed_at, source)
     VALUES
      (@id, @timestamp, @symbol, @direction, @entry, @sl, @tp1, @tp2, @confidence, @regime,
       @outcome, @reason, @dailyBias, @strategy, @realizedR, @resolvedAt, @executedAt, @source)`,
  ).run(row);
}

export function markProExecuted(
  db: Database.Database,
  id: string,
  executedAt: number,
): void {
  db.prepare(
    `UPDATE pro_signals
        SET executed_at = ?
      WHERE id = ? AND executed_at IS NULL`,
  ).run(executedAt, id);
}

export function updateProOutcome(
  db: Database.Database,
  id: string,
  outcome: ProOutcome,
  realizedR: number,
  resolvedAt: number,
): void {
  db.prepare(
    `UPDATE pro_signals
        SET outcome = ?, realized_r = ?, resolved_at = ?
      WHERE id = ?`,
  ).run(outcome, realizedR, resolvedAt, id);
}

export function getLatestPro(db: Database.Database): ProRow | null {
  const r = db
    .prepare(`SELECT * FROM pro_signals ORDER BY timestamp DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;
  return r ? rowFromDb(r) : null;
}

/** Prefer OPEN so active Pro lock stays visible after worker restart. */
export function getOpenOrLatestPro(db: Database.Database): ProRow | null {
  const open = db
    .prepare(
      `SELECT * FROM pro_signals WHERE outcome = 'OPEN' ORDER BY timestamp DESC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  if (open) return rowFromDb(open);
  return getLatestPro(db);
}

export function listProRows(db: Database.Database): ProRow[] {
  const rows = db
    .prepare(`SELECT * FROM pro_signals ORDER BY timestamp ASC`)
    .all() as Record<string, unknown>[];
  return rows.map(rowFromDb);
}

export function countResolvedPro(db: Database.Database): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM pro_signals
        WHERE outcome IN ('TP1_HIT','SL_HIT')`,
    )
    .get() as { n: number };
  return r?.n ?? 0;
}

export function summarizePro(db: Database.Database): {
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  maxDrawdownR: number | null;
} {
  const rows = listProRows(db).filter(
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

/** Badge gate: TP1 winRate ≥ 58%, n≥50, avgR > 0 */
export function isProBacktestValidated(summary: {
  resolved: number;
  winRate: number | null;
  avgR: number | null;
}): boolean {
  return (
    summary.resolved >= 50 &&
    summary.winRate != null &&
    summary.winRate >= 58 &&
    summary.avgR != null &&
    summary.avgR > 0
  );
}

export function assertProDbPath(path: string, expect: "live" | "backtest"): void {
  const p = resolve(path);
  if (expect === "live" && p !== resolve(LIVE_DB_PATH)) {
    throw new Error(`[pro] expected live DB at ${LIVE_DB_PATH}, got ${p}`);
  }
  if (expect === "backtest" && p !== resolve(BACKTEST_DB_PATH)) {
    throw new Error(`[pro] expected backtest DB at ${BACKTEST_DB_PATH}, got ${p}`);
  }
}
