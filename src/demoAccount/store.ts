/**
 * Demo / paper account — SQLite in data/signals.db (isolated tables).
 * Starting balance $2000. Risk % of balance per trade; P&L = riskUsd × R.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = join(ROOT, "data");
export const LIVE_DB_PATH = join(DATA_DIR, "signals.db");

export const DEMO_STARTING_BALANCE = 2000;
export const DEMO_DEFAULT_RISK_PCT = 1;
/** Auto-mirror EXECUTED trades (allowlisted modules only — never Scalp). */
export const DEMO_DEFAULT_AUTO_FOLLOW = true;
export const DEMO_ACCOUNT_ID = "demo-main";

/** Modules that auto-follow into the demo account when autoFollow is ON. */
export const DEMO_AUTO_FOLLOW_MODULES = new Set([
  "intraday",
  "intra30",
  "cipher_b",
  "qs_pro",
  "quick_scalp",
  "fractal",
]);

export function isDemoAutoFollowModule(module: string): boolean {
  return DEMO_AUTO_FOLLOW_MODULES.has(String(module || "").toLowerCase());
}

export type DemoPositionStatus = "OPEN" | "CLOSED";
export type DemoOutcome = "OPEN" | "TP1_HIT" | "TP2_HIT" | "SL_HIT" | "MANUAL";

export interface DemoAccountRow {
  id: string;
  name: string;
  balance: number;
  startingBalance: number;
  riskPct: number;
  autoFollow: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DemoPositionRow {
  id: string;
  accountId: string;
  sourceId: string | null;
  module: string;
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number | null;
  riskUsd: number;
  status: DemoPositionStatus;
  outcome: DemoOutcome;
  realizedR: number | null;
  pnlUsd: number | null;
  openedAt: number;
  closedAt: number | null;
  note: string;
}

export interface DemoLedgerRow {
  id: string;
  accountId: string;
  positionId: string | null;
  kind: "OPEN" | "PNL" | "RESET" | "ADJUST";
  amount: number;
  balanceAfter: number;
  note: string;
  at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS demo_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  balance REAL NOT NULL,
  starting_balance REAL NOT NULL,
  risk_pct REAL NOT NULL DEFAULT 1,
  auto_follow INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_positions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source_id TEXT,
  module TEXT NOT NULL,
  side TEXT NOT NULL,
  entry REAL NOT NULL,
  sl REAL NOT NULL,
  tp1 REAL NOT NULL,
  tp2 REAL,
  risk_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  outcome TEXT NOT NULL DEFAULT 'OPEN',
  realized_r REAL,
  pnl_usd REAL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_demo_pos_acct ON demo_positions(account_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_pos_source
  ON demo_positions(account_id, source_id) WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS demo_ledger (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  position_id TEXT,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  balance_after REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_demo_ledger_acct ON demo_ledger(account_id, at);
`;

let dbInstance: Database.Database | null = null;

function openDb(): Database.Database {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(LIVE_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

export function getDemoDb(): Database.Database {
  if (!dbInstance) dbInstance = openDb();
  return dbInstance;
}

function accountFromRow(r: Record<string, unknown>): DemoAccountRow {
  return {
    id: String(r.id),
    name: String(r.name),
    balance: Number(r.balance),
    startingBalance: Number(r.starting_balance),
    riskPct: Number(r.risk_pct),
    autoFollow: r.auto_follow === 1 || r.auto_follow === true,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function positionFromRow(r: Record<string, unknown>): DemoPositionRow {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    sourceId: r.source_id == null ? null : String(r.source_id),
    module: String(r.module),
    side: r.side as "BUY" | "SELL",
    entry: Number(r.entry),
    sl: Number(r.sl),
    tp1: Number(r.tp1),
    tp2: r.tp2 == null ? null : Number(r.tp2),
    riskUsd: Number(r.risk_usd),
    status: r.status as DemoPositionStatus,
    outcome: r.outcome as DemoOutcome,
    realizedR: r.realized_r == null ? null : Number(r.realized_r),
    pnlUsd: r.pnl_usd == null ? null : Number(r.pnl_usd),
    openedAt: Number(r.opened_at),
    closedAt: r.closed_at == null ? null : Number(r.closed_at),
    note: String(r.note ?? ""),
  };
}

function ledgerFromRow(r: Record<string, unknown>): DemoLedgerRow {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    positionId: r.position_id == null ? null : String(r.position_id),
    kind: r.kind as DemoLedgerRow["kind"],
    amount: Number(r.amount),
    balanceAfter: Number(r.balance_after),
    note: String(r.note ?? ""),
    at: Number(r.at),
  };
}

/** Ensure demo account exists with $2000 starting balance. */
export function ensureDemoAccount(): DemoAccountRow {
  const db = getDemoDb();
  const existing = db
    .prepare(`SELECT * FROM demo_accounts WHERE id = ?`)
    .get(DEMO_ACCOUNT_ID) as Record<string, unknown> | undefined;
  if (existing) return accountFromRow(existing);

  const now = Date.now();
  db.prepare(
    `INSERT INTO demo_accounts
      (id, name, balance, starting_balance, risk_pct, auto_follow, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEMO_ACCOUNT_ID,
    "Demo Gold",
    DEMO_STARTING_BALANCE,
    DEMO_STARTING_BALANCE,
    DEMO_DEFAULT_RISK_PCT,
    DEMO_DEFAULT_AUTO_FOLLOW ? 1 : 0,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO demo_ledger (id, account_id, position_id, kind, amount, balance_after, note, at)
     VALUES (?, ?, NULL, 'RESET', ?, ?, ?, ?)`,
  ).run(
    `ledger-boot-${now}`,
    DEMO_ACCOUNT_ID,
    DEMO_STARTING_BALANCE,
    DEMO_STARTING_BALANCE,
    "Demo account opened",
    now,
  );
  return getDemoAccount()!;
}

export function getDemoAccount(): DemoAccountRow | null {
  const db = getDemoDb();
  const r = db
    .prepare(`SELECT * FROM demo_accounts WHERE id = ?`)
    .get(DEMO_ACCOUNT_ID) as Record<string, unknown> | undefined;
  return r ? accountFromRow(r) : null;
}

export function updateDemoAccountSettings(opts: {
  riskPct?: number;
  autoFollow?: boolean;
}): DemoAccountRow {
  const acct = ensureDemoAccount();
  const db = getDemoDb();
  const risk =
    opts.riskPct != null && Number.isFinite(opts.riskPct) && opts.riskPct > 0
      ? Math.min(10, opts.riskPct)
      : acct.riskPct;
  const auto =
    opts.autoFollow != null ? (opts.autoFollow ? 1 : 0) : acct.autoFollow ? 1 : 0;
  const now = Date.now();
  db.prepare(
    `UPDATE demo_accounts SET risk_pct = ?, auto_follow = ?, updated_at = ? WHERE id = ?`,
  ).run(risk, auto, now, DEMO_ACCOUNT_ID);
  return getDemoAccount()!;
}

export function setDemoBalance(balance: number, note: string): DemoAccountRow {
  const db = getDemoDb();
  ensureDemoAccount();
  const now = Date.now();
  db.prepare(
    `UPDATE demo_accounts SET balance = ?, updated_at = ? WHERE id = ?`,
  ).run(balance, now, DEMO_ACCOUNT_ID);
  db.prepare(
    `INSERT INTO demo_ledger (id, account_id, position_id, kind, amount, balance_after, note, at)
     VALUES (?, ?, NULL, 'ADJUST', ?, ?, ?, ?)`,
  ).run(`ledger-adj-${now}`, DEMO_ACCOUNT_ID, balance, balance, note, now);
  return getDemoAccount()!;
}

export function resetDemoAccount(clearTrades = true): DemoAccountRow {
  const db = getDemoDb();
  ensureDemoAccount();
  const now = Date.now();
  if (clearTrades) {
    db.prepare(`DELETE FROM demo_positions WHERE account_id = ?`).run(DEMO_ACCOUNT_ID);
    db.prepare(`DELETE FROM demo_ledger WHERE account_id = ?`).run(DEMO_ACCOUNT_ID);
  }
  db.prepare(
    `UPDATE demo_accounts
        SET balance = ?, starting_balance = ?, updated_at = ?
      WHERE id = ?`,
  ).run(DEMO_STARTING_BALANCE, DEMO_STARTING_BALANCE, now, DEMO_ACCOUNT_ID);
  db.prepare(
    `INSERT INTO demo_ledger (id, account_id, position_id, kind, amount, balance_after, note, at)
     VALUES (?, ?, NULL, 'RESET', ?, ?, ?, ?)`,
  ).run(
    `ledger-reset-${now}`,
    DEMO_ACCOUNT_ID,
    DEMO_STARTING_BALANCE,
    DEMO_STARTING_BALANCE,
    "Balance reset to $2000",
    now,
  );
  return getDemoAccount()!;
}

export function listOpenDemoPositions(): DemoPositionRow[] {
  const db = getDemoDb();
  const rows = db
    .prepare(
      `SELECT * FROM demo_positions WHERE account_id = ? AND status = 'OPEN' ORDER BY opened_at DESC`,
    )
    .all(DEMO_ACCOUNT_ID) as Record<string, unknown>[];
  return rows.map(positionFromRow);
}

export function listDemoPositions(limit = 50): DemoPositionRow[] {
  const db = getDemoDb();
  const rows = db
    .prepare(
      `SELECT * FROM demo_positions WHERE account_id = ? ORDER BY opened_at DESC LIMIT ?`,
    )
    .all(DEMO_ACCOUNT_ID, limit) as Record<string, unknown>[];
  return rows.map(positionFromRow);
}

export function listDemoLedger(limit = 40): DemoLedgerRow[] {
  const db = getDemoDb();
  const rows = db
    .prepare(
      `SELECT * FROM demo_ledger WHERE account_id = ? ORDER BY at DESC LIMIT ?`,
    )
    .all(DEMO_ACCOUNT_ID, limit) as Record<string, unknown>[];
  return rows.map(ledgerFromRow);
}

export function findDemoBySourceId(sourceId: string): DemoPositionRow | null {
  const db = getDemoDb();
  const r = db
    .prepare(
      `SELECT * FROM demo_positions WHERE account_id = ? AND source_id = ?`,
    )
    .get(DEMO_ACCOUNT_ID, sourceId) as Record<string, unknown> | undefined;
  return r ? positionFromRow(r) : null;
}

export function insertDemoPosition(row: DemoPositionRow): void {
  const db = getDemoDb();
  db.prepare(
    `INSERT INTO demo_positions
      (id, account_id, source_id, module, side, entry, sl, tp1, tp2, risk_usd,
       status, outcome, realized_r, pnl_usd, opened_at, closed_at, note)
     VALUES
      (@id, @accountId, @sourceId, @module, @side, @entry, @sl, @tp1, @tp2, @riskUsd,
       @status, @outcome, @realizedR, @pnlUsd, @openedAt, @closedAt, @note)`,
  ).run(row);
}

export function closeDemoPositionInDb(
  id: string,
  outcome: DemoOutcome,
  realizedR: number,
  pnlUsd: number,
  closedAt: number,
): void {
  const db = getDemoDb();
  db.prepare(
    `UPDATE demo_positions
        SET status = 'CLOSED', outcome = ?, realized_r = ?, pnl_usd = ?, closed_at = ?
      WHERE id = ? AND status = 'OPEN'`,
  ).run(outcome, realizedR, pnlUsd, closedAt, id);
}

export function applyPnlToBalance(
  positionId: string,
  pnlUsd: number,
  note: string,
  at: number,
): number {
  const db = getDemoDb();
  const acct = ensureDemoAccount();
  const next = Math.round((acct.balance + pnlUsd) * 100) / 100;
  db.prepare(
    `UPDATE demo_accounts SET balance = ?, updated_at = ? WHERE id = ?`,
  ).run(next, at, DEMO_ACCOUNT_ID);
  db.prepare(
    `INSERT INTO demo_ledger (id, account_id, position_id, kind, amount, balance_after, note, at)
     VALUES (?, ?, ?, 'PNL', ?, ?, ?, ?)`,
  ).run(`ledger-pnl-${positionId}-${at}`, DEMO_ACCOUNT_ID, positionId, pnlUsd, next, note, at);
  return next;
}

export function assertDemoDbPath(path: string): void {
  if (resolve(path) !== resolve(LIVE_DB_PATH)) {
    throw new Error(`[demoAccount] expected ${LIVE_DB_PATH}, got ${path}`);
  }
}
