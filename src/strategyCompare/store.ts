/**
 * Shared comparison store for isolated strategies:
 * cipher_b_clone | ict | fractal
 *
 * Table: strategy_signals (live + backtest DBs).
 * Does NOT touch main `signals` or Quick Scalp's `quick_scalp_signals`.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = join(ROOT, "data");
export const LIVE_DB_PATH = join(DATA_DIR, "signals.db");
export const BACKTEST_DB_PATH = join(DATA_DIR, "backtest-results.db");

export type CompareStrategy = "cipher_b_clone" | "ict" | "fractal";
export type StrategyOutcome = "OPEN" | "TP1_HIT" | "SL_HIT" | "INVALIDATED";

export interface StrategySignalRow {
  id: string;
  strategy: CompareStrategy;
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  reason: string;
  time: number;
  outcome: StrategyOutcome;
  resolvedAt: number | null;
  createdAt: number;
  realizedR: number | null;
  symbol: string;
  source: "live" | "backtest";
  /** When price first hit entry — null until trade actually starts. */
  executedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS strategy_signals (
  id            TEXT PRIMARY KEY,
  strategy      TEXT NOT NULL,
  direction     TEXT NOT NULL,
  entry         REAL NOT NULL,
  sl            REAL NOT NULL,
  tp1           REAL NOT NULL,
  tp2           REAL NOT NULL,
  reason        TEXT NOT NULL DEFAULT '[]',
  time          INTEGER NOT NULL,
  outcome       TEXT NOT NULL DEFAULT 'OPEN',
  resolved_at   INTEGER,
  created_at    INTEGER NOT NULL,
  realized_r    REAL,
  symbol        TEXT NOT NULL DEFAULT 'XAUUSD',
  source        TEXT NOT NULL DEFAULT 'live',
  executed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ss_strategy_time ON strategy_signals(strategy, time);
CREATE INDEX IF NOT EXISTS idx_ss_outcome ON strategy_signals(outcome);
`;

function ensureExecutedAtColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(strategy_signals)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "executed_at")) {
    db.exec(`ALTER TABLE strategy_signals ADD COLUMN executed_at INTEGER`);
  }
}

function ensureCompatView(db: Database.Database): void {
  const hasQs = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='quick_scalp_signals'`,
    )
    .get() as { ok: number } | undefined;
  db.exec(`DROP VIEW IF EXISTS strategy_signals_with_quick_scalp`);
  if (hasQs) {
    db.exec(`
CREATE VIEW strategy_signals_with_quick_scalp AS
  SELECT id, strategy, direction, entry, sl, tp1, tp2, reason,
         time, outcome, resolved_at, created_at, realized_r, symbol, source
    FROM strategy_signals
  UNION ALL
  SELECT id, strategy, direction, entry, sl, tp1, tp2, reason,
         timestamp AS time, outcome, resolved_at, timestamp AS created_at,
         realized_r, symbol, source
    FROM quick_scalp_signals
`);
  } else {
    db.exec(`
CREATE VIEW strategy_signals_with_quick_scalp AS
  SELECT id, strategy, direction, entry, sl, tp1, tp2, reason,
         time, outcome, resolved_at, created_at, realized_r, symbol, source
    FROM strategy_signals
`);
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
  ensureCompatView(db);
  return db;
}

export function getLiveStrategyDb(): Database.Database {
  if (liveDb) return liveDb;
  liveDb = openDb(LIVE_DB_PATH, 0x53545241); // 'STRA'
  return liveDb;
}

export function getBacktestStrategyDb(reset = false): Database.Database {
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
    const tmp = openDb(BACKTEST_DB_PATH, 0x53545242);
    // Only drop shared compare table — never main signals or quick_scalp_signals.
    tmp.exec("DROP TABLE IF EXISTS strategy_signals");
    tmp.exec("DROP VIEW IF EXISTS strategy_signals_with_quick_scalp");
    tmp.close();
  }
  backtestDb = openDb(BACKTEST_DB_PATH, 0x53545242);
  return backtestDb;
}

function rowFromDb(r: Record<string, unknown>): StrategySignalRow {
  return {
    id: String(r.id),
    strategy: r.strategy as CompareStrategy,
    direction: r.direction as "BUY" | "SELL",
    entry: Number(r.entry),
    sl: Number(r.sl),
    tp1: Number(r.tp1),
    tp2: Number(r.tp2),
    reason: String(r.reason ?? "[]"),
    time: Number(r.time),
    outcome: r.outcome as StrategyOutcome,
    resolvedAt: r.resolved_at == null ? null : Number(r.resolved_at),
    createdAt: Number(r.created_at),
    realizedR: r.realized_r == null ? null : Number(r.realized_r),
    symbol: String(r.symbol ?? "XAUUSD"),
    source: (r.source as "live" | "backtest") ?? "live",
    executedAt: r.executed_at == null ? null : Number(r.executed_at),
  };
}

export function makeStrategyRow(input: {
  strategy: CompareStrategy;
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  reason: string[];
  time: number;
  symbol: string;
  source: "live" | "backtest";
}): StrategySignalRow {
  const now = Date.now();
  const time = input.source === "live" ? now : input.time;
  return {
    id: `${input.strategy}-${input.source}-${time}-${input.direction}-${input.entry}`,
    strategy: input.strategy,
    direction: input.direction,
    entry: input.entry,
    sl: input.sl,
    tp1: input.tp1,
    tp2: input.tp2,
    reason: JSON.stringify(input.reason),
    time,
    outcome: "OPEN",
    resolvedAt: null,
    createdAt: now,
    realizedR: null,
    symbol: input.symbol,
    source: input.source,
    executedAt: null,
  };
}

export function insertStrategyRow(db: Database.Database, row: StrategySignalRow): void {
  db.prepare(
    `INSERT OR IGNORE INTO strategy_signals
      (id, strategy, direction, entry, sl, tp1, tp2, reason, time, outcome,
       resolved_at, created_at, realized_r, symbol, source, executed_at)
     VALUES
      (@id, @strategy, @direction, @entry, @sl, @tp1, @tp2, @reason, @time, @outcome,
       @resolvedAt, @createdAt, @realizedR, @symbol, @source, @executedAt)`,
  ).run(row);
}

export function markStrategyExecuted(
  db: Database.Database,
  id: string,
  executedAt: number,
): void {
  db.prepare(
    `UPDATE strategy_signals
        SET executed_at = ?
      WHERE id = ? AND executed_at IS NULL`,
  ).run(executedAt, id);
}

export function updateStrategyOutcome(
  db: Database.Database,
  id: string,
  outcome: StrategyOutcome,
  realizedR: number,
  resolvedAt: number,
): void {
  db.prepare(
    `UPDATE strategy_signals
        SET outcome = ?, realized_r = ?, resolved_at = ?
      WHERE id = ?`,
  ).run(outcome, realizedR, resolvedAt, id);
}

export function getLatestStrategySignal(
  db: Database.Database,
  strategy: CompareStrategy,
): StrategySignalRow | null {
  const r = db
    .prepare(
      `SELECT * FROM strategy_signals WHERE strategy = ? ORDER BY time DESC LIMIT 1`,
    )
    .get(strategy) as Record<string, unknown> | undefined;
  return r ? rowFromDb(r) : null;
}

/** Prefer OPEN so Fractal/Cipher lock stays visible after redeploy. */
export function getOpenOrLatestStrategySignal(
  db: Database.Database,
  strategy: CompareStrategy,
): StrategySignalRow | null {
  const open = db
    .prepare(
      `SELECT * FROM strategy_signals WHERE strategy = ? AND outcome = 'OPEN' ORDER BY time DESC LIMIT 1`,
    )
    .get(strategy) as Record<string, unknown> | undefined;
  if (open) return rowFromDb(open);
  return getLatestStrategySignal(db, strategy);
}

export function listStrategyRows(
  db: Database.Database,
  strategy?: CompareStrategy,
): StrategySignalRow[] {
  const rows = (
    strategy
      ? db
          .prepare(`SELECT * FROM strategy_signals WHERE strategy = ? ORDER BY time ASC`)
          .all(strategy)
      : db.prepare(`SELECT * FROM strategy_signals ORDER BY time ASC`).all()
  ) as Record<string, unknown>[];
  return rows.map(rowFromDb);
}

export function countResolvedStrategy(
  db: Database.Database,
  strategy: CompareStrategy,
): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n FROM strategy_signals
        WHERE strategy = ? AND outcome IN ('TP1_HIT','SL_HIT')`,
    )
    .get(strategy) as { n: number };
  return r?.n ?? 0;
}

export function summarizeStrategy(
  db: Database.Database,
  strategy: CompareStrategy,
): {
  resolved: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  maxDrawdownR: number | null;
} {
  const rows = listStrategyRows(db, strategy).filter(
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

export function assertStrategyDbPath(path: string, expect: "live" | "backtest"): void {
  const p = resolve(path);
  if (expect === "live" && p !== resolve(LIVE_DB_PATH)) {
    throw new Error(`[strategyCompare] expected live DB at ${LIVE_DB_PATH}, got ${p}`);
  }
  if (expect === "backtest" && p !== resolve(BACKTEST_DB_PATH)) {
    throw new Error(`[strategyCompare] expected backtest DB at ${BACKTEST_DB_PATH}, got ${p}`);
  }
}
