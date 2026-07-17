/**
 * Backtest-only SQLite store. NEVER opens data/signals.db.
 * Path: data/backtest-results.db
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoggedSignal } from "../calibration/types";
import { BACKTEST_RESULTS_DB_PATH, DATA_DIR } from "../calibration/db";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_DB = resolve(join(ROOT, "data", "signals.db"));

let dbInstance: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  mode TEXT NOT NULL,
  side TEXT NOT NULL,
  entry REAL NOT NULL,
  sl REAL NOT NULL,
  tp1 REAL NOT NULL,
  tp2 REAL NOT NULL,
  tp3 REAL NOT NULL,
  confidence REAL NOT NULL,
  win_chance_displayed REAL NOT NULL,
  win_chance_calibrated REAL,
  confluence_pct REAL NOT NULL DEFAULT 0,
  smc_score REAL NOT NULL DEFAULT 0,
  ma_score REAL NOT NULL DEFAULT 0,
  pa_score REAL NOT NULL DEFAULT 0,
  bull_pts REAL NOT NULL DEFAULT 0,
  bear_pts REAL NOT NULL DEFAULT 0,
  htf_aligned INTEGER NOT NULL DEFAULT 0,
  daily_bias TEXT NOT NULL DEFAULT '',
  conflicting_signals INTEGER NOT NULL DEFAULT 0,
  conflict_capped INTEGER NOT NULL DEFAULT 0,
  plan_key TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL,
  outcome_tp1 TEXT,
  resolved_at INTEGER,
  realized_r REAL,
  realized_r_full REAL,
  full_plan_closed INTEGER NOT NULL DEFAULT 0,
  tp2_hit INTEGER NOT NULL DEFAULT 0,
  tp3_hit INTEGER NOT NULL DEFAULT 0,
  sl_after_tp1 INTEGER NOT NULL DEFAULT 0,
  tp1_hit_at INTEGER,
  tp2_hit_at INTEGER,
  tp3_hit_at INTEGER,
  sl_after_tp1_at INTEGER,
  atr14 REAL,
  atr_pct_of_price REAL,
  regime TEXT,
  resolve_note TEXT,
  zone_touched_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bt_ts ON signals(timestamp);
`;

function assertNotLive(path: string): void {
  if (resolve(path) === LIVE_DB) {
    throw new Error(
      "[backtest] Refusing to open live signals.db from backtest store",
    );
  }
}

function boolToInt(v: boolean): number {
  return v ? 1 : 0;
}

function intToBool(v: unknown): boolean {
  return v === 1 || v === true;
}

type DbRow = Record<string, unknown>;

function rowToSignal(row: DbRow): LoggedSignal {
  return {
    id: String(row.id),
    timestamp: Number(row.timestamp),
    symbol: row.symbol as LoggedSignal["symbol"],
    mode: row.mode as LoggedSignal["mode"],
    side: row.side as "BUY" | "SELL",
    entry: Number(row.entry),
    sl: Number(row.sl),
    tp1: Number(row.tp1),
    tp2: Number(row.tp2),
    tp3: Number(row.tp3),
    confidence: Number(row.confidence),
    winChanceDisplayed: Number(row.win_chance_displayed),
    winChanceCalibrated:
      row.win_chance_calibrated == null ? null : Number(row.win_chance_calibrated),
    confluencePct: Number(row.confluence_pct ?? 0),
    smcScore: Number(row.smc_score ?? 0),
    maScore: Number(row.ma_score ?? 0),
    paScore: Number(row.pa_score ?? 0),
    bullPts: Number(row.bull_pts ?? 0),
    bearPts: Number(row.bear_pts ?? 0),
    htfAligned: intToBool(row.htf_aligned),
    dailyBias: String(row.daily_bias ?? ""),
    conflictingSignals: intToBool(row.conflicting_signals),
    conflictCapped: intToBool(row.conflict_capped),
    planKey: String(row.plan_key),
    outcome: row.outcome as LoggedSignal["outcome"],
    outcomeTp1: (row.outcome_tp1 as LoggedSignal["outcomeTp1"]) ?? null,
    resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
    realizedR: row.realized_r == null ? null : Number(row.realized_r),
    realizedRFull: row.realized_r_full == null ? null : Number(row.realized_r_full),
    fullPlanClosed: intToBool(row.full_plan_closed),
    tp2Hit: intToBool(row.tp2_hit),
    tp3Hit: intToBool(row.tp3_hit),
    slAfterTp1: intToBool(row.sl_after_tp1),
    tp1HitAt: row.tp1_hit_at == null ? null : Number(row.tp1_hit_at),
    tp2HitAt: row.tp2_hit_at == null ? null : Number(row.tp2_hit_at),
    tp3HitAt: row.tp3_hit_at == null ? null : Number(row.tp3_hit_at),
    slAfterTp1At: row.sl_after_tp1_at == null ? null : Number(row.sl_after_tp1_at),
    atr14: row.atr14 == null ? null : Number(row.atr14),
    atrPctOfPrice: row.atr_pct_of_price == null ? null : Number(row.atr_pct_of_price),
    regime: (row.regime as LoggedSignal["regime"]) ?? null,
    resolveNote: row.resolve_note == null ? undefined : String(row.resolve_note),
    zoneTouchedAt: row.zone_touched_at == null ? null : Number(row.zone_touched_at),
  };
}

function signalToParams(s: LoggedSignal): DbRow {
  return {
    id: s.id,
    timestamp: s.timestamp,
    symbol: s.symbol,
    mode: s.mode,
    side: s.side,
    entry: s.entry,
    sl: s.sl,
    tp1: s.tp1,
    tp2: s.tp2,
    tp3: s.tp3,
    confidence: s.confidence,
    win_chance_displayed: s.winChanceDisplayed,
    win_chance_calibrated: s.winChanceCalibrated,
    confluence_pct: s.confluencePct,
    smc_score: s.smcScore,
    ma_score: s.maScore,
    pa_score: s.paScore,
    bull_pts: s.bullPts,
    bear_pts: s.bearPts,
    htf_aligned: boolToInt(s.htfAligned),
    daily_bias: s.dailyBias,
    conflicting_signals: boolToInt(s.conflictingSignals),
    conflict_capped: boolToInt(s.conflictCapped),
    plan_key: s.planKey,
    outcome: s.outcome,
    outcome_tp1: s.outcomeTp1,
    resolved_at: s.resolvedAt,
    realized_r: s.realizedR,
    realized_r_full: s.realizedRFull,
    full_plan_closed: boolToInt(s.fullPlanClosed),
    tp2_hit: boolToInt(s.tp2Hit),
    tp3_hit: boolToInt(s.tp3Hit),
    sl_after_tp1: boolToInt(s.slAfterTp1),
    tp1_hit_at: s.tp1HitAt,
    tp2_hit_at: s.tp2HitAt,
    tp3_hit_at: s.tp3HitAt,
    sl_after_tp1_at: s.slAfterTp1At,
    atr14: s.atr14,
    atr_pct_of_price: s.atrPctOfPrice,
    regime: s.regime,
    resolve_note: s.resolveNote ?? null,
    zone_touched_at: s.zoneTouchedAt ?? null,
  };
}

export function getBacktestDbPath(): string {
  return BACKTEST_RESULTS_DB_PATH;
}

export function openBacktestDb(reset = false): Database.Database {
  assertNotLive(BACKTEST_RESULTS_DB_PATH);
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (reset && existsSync(BACKTEST_RESULTS_DB_PATH)) {
    // better-sqlite3: delete via unlink handled by caller; here just recreate tables
  }
  try {
    if (dbInstance) {
      dbInstance.close();
      dbInstance = null;
    }
    const db = new Database(BACKTEST_RESULTS_DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("application_id = 0x4254434B"); // 'BTCK'
    if (reset) {
      db.exec("DROP TABLE IF EXISTS signals");
    }
    db.exec(SCHEMA);
    dbInstance = db;
    return db;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[backtest] Failed to open ${BACKTEST_RESULTS_DB_PATH}: ${msg}`);
  }
}

export function insertBacktestSignal(db: Database.Database, signal: LoggedSignal): void {
  assertNotLive(BACKTEST_RESULTS_DB_PATH);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO signals (
      id, timestamp, symbol, mode, side, entry, sl, tp1, tp2, tp3,
      confidence, win_chance_displayed, win_chance_calibrated,
      confluence_pct, smc_score, ma_score, pa_score, bull_pts, bear_pts,
      htf_aligned, daily_bias, conflicting_signals, conflict_capped, plan_key,
      outcome, outcome_tp1, resolved_at, realized_r, realized_r_full,
      full_plan_closed, tp2_hit, tp3_hit, sl_after_tp1,
      tp1_hit_at, tp2_hit_at, tp3_hit_at, sl_after_tp1_at,
      atr14, atr_pct_of_price, regime, resolve_note, zone_touched_at
    ) VALUES (
      @id, @timestamp, @symbol, @mode, @side, @entry, @sl, @tp1, @tp2, @tp3,
      @confidence, @win_chance_displayed, @win_chance_calibrated,
      @confluence_pct, @smc_score, @ma_score, @pa_score, @bull_pts, @bear_pts,
      @htf_aligned, @daily_bias, @conflicting_signals, @conflict_capped, @plan_key,
      @outcome, @outcome_tp1, @resolved_at, @realized_r, @realized_r_full,
      @full_plan_closed, @tp2_hit, @tp3_hit, @sl_after_tp1,
      @tp1_hit_at, @tp2_hit_at, @tp3_hit_at, @sl_after_tp1_at,
      @atr14, @atr_pct_of_price, @regime, @resolve_note, @zone_touched_at
    )
  `);
  stmt.run(signalToParams(signal));
}

export function updateBacktestSignal(db: Database.Database, signal: LoggedSignal): void {
  const stmt = db.prepare(`
    UPDATE signals SET
      outcome=@outcome, outcome_tp1=@outcome_tp1, resolved_at=@resolved_at,
      realized_r=@realized_r, realized_r_full=@realized_r_full,
      full_plan_closed=@full_plan_closed, tp2_hit=@tp2_hit, tp3_hit=@tp3_hit,
      sl_after_tp1=@sl_after_tp1, tp1_hit_at=@tp1_hit_at, tp2_hit_at=@tp2_hit_at,
      tp3_hit_at=@tp3_hit_at, sl_after_tp1_at=@sl_after_tp1_at,
      resolve_note=@resolve_note, zone_touched_at=@zone_touched_at
    WHERE id=@id
  `);
  stmt.run(signalToParams(signal));
}

export function listBacktestSignals(db: Database.Database): LoggedSignal[] {
  const rows = db.prepare("SELECT * FROM signals ORDER BY timestamp ASC").all() as DbRow[];
  return rows.map(rowToSignal);
}

export function closeBacktestDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
