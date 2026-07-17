/**
 * Shared SQLite store for signal outcome tracking.
 * WAL mode + single-writer-safe better-sqlite3 (sync API).
 * All logger / resolver / calibrate / Vite API paths must use this module.
 */
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LoggedSignal,
  OutcomeTp1,
  RegimeTag,
  SignalOutcome,
  SignalStoreFile,
} from "./types";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = join(ROOT, "data");
export const SIGNAL_DB_PATH = join(DATA_DIR, "signals.db");
export const SIGNAL_LOG_JSON_PATH = join(DATA_DIR, "signal-log.json");
export const SIGNAL_LOG_MIGRATED_PATH = join(DATA_DIR, "signal-log.json.migrated");

/** @deprecated Prefer SIGNAL_DB_PATH — kept for CLI banners / API stats */
export const SIGNAL_LOG_PATH = SIGNAL_DB_PATH;

let dbInstance: Database.Database | null = null;
let lastMigrationReport: MigrationReport | null = null;

export interface MigrationReport {
  imported: number;
  skipped: number;
  source: string | null;
  alreadyMigrated: boolean;
}

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
  resolve_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_signals_symbol_outcome ON signals(symbol, outcome);
CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
CREATE INDEX IF NOT EXISTS idx_signals_outcome_tp1 ON signals(outcome_tp1);
`;

type DbRow = Record<string, unknown>;

function boolToInt(v: boolean): number {
  return v ? 1 : 0;
}

function intToBool(v: unknown): boolean {
  return v === 1 || v === true;
}

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
    outcome: row.outcome as SignalOutcome,
    outcomeTp1: (row.outcome_tp1 as OutcomeTp1 | null) ?? null,
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
    regime: (row.regime as RegimeTag | null) ?? null,
    resolveNote: row.resolve_note == null ? undefined : String(row.resolve_note),
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
  };
}

function openDatabase(): Database.Database {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const db = new Database(SIGNAL_DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(SCHEMA);
    return db;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/locked|SQLITE_BUSY/i.test(msg)) {
      throw new Error(
        `[calibration] SQLite database is locked (${SIGNAL_DB_PATH}). ` +
          `Close other npm run alerts / vite processes and retry. Detail: ${msg}`,
      );
    }
    if (/corrupt|malformed|not a database/i.test(msg)) {
      throw new Error(
        `[calibration] SQLite database is corrupt (${SIGNAL_DB_PATH}). ` +
          `Move or delete the file and re-import from signal-log.json.migrated if available. Detail: ${msg}`,
      );
    }
    throw new Error(`[calibration] Failed to open SQLite store (${SIGNAL_DB_PATH}): ${msg}`);
  }
}

function normalizeLegacyOutcome(raw: Partial<LoggedSignal>): {
  outcome: SignalOutcome;
  outcomeTp1: OutcomeTp1 | null;
} {
  const outcome = (raw.outcome as SignalOutcome) || "OPEN";
  if (raw.outcomeTp1 === "WIN" || raw.outcomeTp1 === "LOSS") {
    return { outcome, outcomeTp1: raw.outcomeTp1 };
  }
  if (outcome === "TP1_HIT") return { outcome, outcomeTp1: "WIN" };
  if (outcome === "SL_HIT") return { outcome, outcomeTp1: "LOSS" };
  return { outcome, outcomeTp1: null };
}

function coerceLegacyRow(raw: unknown, index: number): LoggedSignal | null {
  if (!raw || typeof raw !== "object") {
    console.warn(`[calibration] Skipping malformed JSON row #${index}: not an object`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const side = r.side;
  if (side !== "BUY" && side !== "SELL") {
    console.warn(`[calibration] Skipping malformed JSON row #${index}: invalid side`);
    return null;
  }
  const entry = Number(r.entry);
  const sl = Number(r.sl);
  const tp1 = Number(r.tp1);
  if (![entry, sl, tp1].every((n) => Number.isFinite(n))) {
    console.warn(`[calibration] Skipping malformed JSON row #${index}: bad levels`);
    return null;
  }

  const planKey =
    typeof r.planKey === "string" && r.planKey
      ? r.planKey
      : makePlanKey(
          String(r.symbol ?? ""),
          String(r.mode ?? ""),
          String(side),
          entry,
          sl,
          tp1,
        );

  const { outcome, outcomeTp1 } = normalizeLegacyOutcome(r as Partial<LoggedSignal>);
  const fullClosed =
    outcome === "SL_HIT" ||
    outcome === "INVALIDATED" ||
    (outcomeTp1 === "WIN" && intToBool(r.fullPlanClosed));

  return {
    id: typeof r.id === "string" ? r.id : `migrated-${index}-${Date.now()}`,
    timestamp: Number(r.timestamp) || Date.now(),
    symbol: r.symbol as LoggedSignal["symbol"],
    mode: r.mode as LoggedSignal["mode"],
    side,
    entry,
    sl,
    tp1,
    tp2: Number(r.tp2) || tp1,
    tp3: Number(r.tp3) || tp1,
    confidence: Number(r.confidence) || 0,
    winChanceDisplayed: Number(r.winChanceDisplayed) || Number(r.confidence) || 0,
    winChanceCalibrated:
      r.winChanceCalibrated == null ? null : Number(r.winChanceCalibrated),
    confluencePct: Number(r.confluencePct) || 0,
    smcScore: Number(r.smcScore) || 0,
    maScore: Number(r.maScore) || 0,
    paScore: Number(r.paScore) || 0,
    bullPts: Number(r.bullPts) || 0,
    bearPts: Number(r.bearPts) || 0,
    htfAligned: Boolean(r.htfAligned),
    dailyBias: String(r.dailyBias ?? ""),
    conflictingSignals: Boolean(r.conflictingSignals),
    conflictCapped: Boolean(r.conflictCapped ?? r.conflictingSignals),
    planKey,
    outcome,
    outcomeTp1,
    resolvedAt: r.resolvedAt == null ? null : Number(r.resolvedAt),
    realizedR: r.realizedR == null ? null : Number(r.realizedR),
    realizedRFull:
      r.realizedRFull == null
        ? r.realizedR == null
          ? null
          : Number(r.realizedR)
        : Number(r.realizedRFull),
    fullPlanClosed: fullClosed || outcome === "SL_HIT",
    tp2Hit: Boolean(r.tp2Hit),
    tp3Hit: Boolean(r.tp3Hit),
    slAfterTp1: Boolean(r.slAfterTp1),
    tp1HitAt: r.tp1HitAt == null ? (outcomeTp1 === "WIN" ? Number(r.resolvedAt) || null : null) : Number(r.tp1HitAt),
    tp2HitAt: r.tp2HitAt == null ? null : Number(r.tp2HitAt),
    tp3HitAt: r.tp3HitAt == null ? null : Number(r.tp3HitAt),
    slAfterTp1At: r.slAfterTp1At == null ? null : Number(r.slAfterTp1At),
    atr14: r.atr14 == null ? null : Number(r.atr14),
    atrPctOfPrice: r.atrPctOfPrice == null ? null : Number(r.atrPctOfPrice),
    regime: (r.regime as RegimeTag | null) ?? null,
    resolveNote: r.resolveNote == null ? undefined : String(r.resolveNote),
  };
}

function migrateJsonIfNeeded(db: Database.Database): MigrationReport {
  if (existsSync(SIGNAL_LOG_MIGRATED_PATH) && !existsSync(SIGNAL_LOG_JSON_PATH)) {
    return { imported: 0, skipped: 0, source: null, alreadyMigrated: true };
  }

  if (!existsSync(SIGNAL_LOG_JSON_PATH)) {
    return { imported: 0, skipped: 0, source: null, alreadyMigrated: false };
  }

  let imported = 0;
  let skipped = 0;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO signals (
      id, timestamp, symbol, mode, side, entry, sl, tp1, tp2, tp3,
      confidence, win_chance_displayed, win_chance_calibrated,
      confluence_pct, smc_score, ma_score, pa_score, bull_pts, bear_pts,
      htf_aligned, daily_bias, conflicting_signals, conflict_capped, plan_key,
      outcome, outcome_tp1, resolved_at, realized_r, realized_r_full,
      full_plan_closed, tp2_hit, tp3_hit, sl_after_tp1,
      tp1_hit_at, tp2_hit_at, tp3_hit_at, sl_after_tp1_at,
      atr14, atr_pct_of_price, regime, resolve_note
    ) VALUES (
      @id, @timestamp, @symbol, @mode, @side, @entry, @sl, @tp1, @tp2, @tp3,
      @confidence, @win_chance_displayed, @win_chance_calibrated,
      @confluence_pct, @smc_score, @ma_score, @pa_score, @bull_pts, @bear_pts,
      @htf_aligned, @daily_bias, @conflicting_signals, @conflict_capped, @plan_key,
      @outcome, @outcome_tp1, @resolved_at, @realized_r, @realized_r_full,
      @full_plan_closed, @tp2_hit, @tp3_hit, @sl_after_tp1,
      @tp1_hit_at, @tp2_hit_at, @tp3_hit_at, @sl_after_tp1_at,
      @atr14, @atr_pct_of_price, @regime, @resolve_note
    )
  `);

  try {
    const raw = readFileSync(SIGNAL_LOG_JSON_PATH, "utf8").replace(/^\uFEFF/, "");
    if (!raw.trim()) {
      renameSync(SIGNAL_LOG_JSON_PATH, SIGNAL_LOG_MIGRATED_PATH);
      console.log("[calibration] Empty signal-log.json renamed to signal-log.json.migrated");
      return { imported: 0, skipped: 0, source: SIGNAL_LOG_JSON_PATH, alreadyMigrated: false };
    }

    const parsed = JSON.parse(raw) as Partial<SignalStoreFile> | LoggedSignal[];
    const rows = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.signals)
        ? parsed.signals
        : null;

    if (!rows) {
      console.warn(
        "[calibration] signal-log.json has unexpected shape — renaming without import",
      );
      renameSync(SIGNAL_LOG_JSON_PATH, SIGNAL_LOG_MIGRATED_PATH);
      return { imported: 0, skipped: 0, source: SIGNAL_LOG_JSON_PATH, alreadyMigrated: false };
    }

    const tx = db.transaction(() => {
      rows.forEach((item, i) => {
        const sig = coerceLegacyRow(item, i);
        if (!sig) {
          skipped += 1;
          return;
        }
        const result = insert.run(signalToParams(sig));
        if (result.changes > 0) imported += 1;
        else skipped += 1;
      });
    });
    tx();

    renameSync(SIGNAL_LOG_JSON_PATH, SIGNAL_LOG_MIGRATED_PATH);
    console.log(
      `[calibration] Migrated signal-log.json → SQLite: imported=${imported} skipped=${skipped}. ` +
        `JSON renamed to signal-log.json.migrated`,
    );
    return {
      imported,
      skipped,
      source: SIGNAL_LOG_JSON_PATH,
      alreadyMigrated: false,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[calibration] Failed migrating signal-log.json to SQLite: ${msg}`,
    );
  }
}

/** Open (or reuse) the shared DB; runs one-time JSON migration on first open. */
export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  dbInstance = openDatabase();
  lastMigrationReport = migrateJsonIfNeeded(dbInstance);
  return dbInstance;
}

export function getLastMigrationReport(): MigrationReport | null {
  return lastMigrationReport;
}

/** Force open + migration (for CLI). */
export function ensureDbMigrated(): MigrationReport {
  getDb();
  return (
    lastMigrationReport ?? {
      imported: 0,
      skipped: 0,
      source: null,
      alreadyMigrated: true,
    }
  );
}

export function makePlanKey(
  symbol: string,
  mode: string,
  side: string,
  entry: number,
  sl: number,
  tp1: number,
): string {
  return `${symbol}|${mode}|${side}|${entry}|${sl}|${tp1}`;
}

export function listAllSignals(): LoggedSignal[] {
  const db = getDb();
  try {
    const rows = db.prepare("SELECT * FROM signals ORDER BY timestamp ASC").all() as DbRow[];
    return rows.map(rowToSignal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[calibration] Failed to list signals: ${msg}`);
  }
}

/** Compatibility shim for code that expected the old JSON store object. */
export function loadSignalStore(): { version: 1; updatedAt: number; signals: LoggedSignal[] } {
  return {
    version: 1,
    updatedAt: Date.now(),
    signals: listAllSignals(),
  };
}

/** @deprecated No-op — SQLite writes are per-row. Kept so old call sites compile during transition. */
export function saveSignalStore(_store: { signals: LoggedSignal[] }): void {
  /* writes go through insertSignal / updateSignal */
}

export function findByPlanKey(planKey: string): LoggedSignal | null {
  const db = getDb();
  try {
    const row = db.prepare("SELECT * FROM signals WHERE plan_key = ?").get(planKey) as
      | DbRow
      | undefined;
    return row ? rowToSignal(row) : null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[calibration] Failed to find plan_key=${planKey}: ${msg}`);
  }
}

/** INSERT OR IGNORE on unique plan_key. Returns existing row if duplicate. */
export function insertSignal(signal: LoggedSignal): LoggedSignal {
  const db = getDb();
  const existing = findByPlanKey(signal.planKey);
  if (existing) return existing;

  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO signals (
        id, timestamp, symbol, mode, side, entry, sl, tp1, tp2, tp3,
        confidence, win_chance_displayed, win_chance_calibrated,
        confluence_pct, smc_score, ma_score, pa_score, bull_pts, bear_pts,
        htf_aligned, daily_bias, conflicting_signals, conflict_capped, plan_key,
        outcome, outcome_tp1, resolved_at, realized_r, realized_r_full,
        full_plan_closed, tp2_hit, tp3_hit, sl_after_tp1,
        tp1_hit_at, tp2_hit_at, tp3_hit_at, sl_after_tp1_at,
        atr14, atr_pct_of_price, regime, resolve_note
      ) VALUES (
        @id, @timestamp, @symbol, @mode, @side, @entry, @sl, @tp1, @tp2, @tp3,
        @confidence, @win_chance_displayed, @win_chance_calibrated,
        @confluence_pct, @smc_score, @ma_score, @pa_score, @bull_pts, @bear_pts,
        @htf_aligned, @daily_bias, @conflicting_signals, @conflict_capped, @plan_key,
        @outcome, @outcome_tp1, @resolved_at, @realized_r, @realized_r_full,
        @full_plan_closed, @tp2_hit, @tp3_hit, @sl_after_tp1,
        @tp1_hit_at, @tp2_hit_at, @tp3_hit_at, @sl_after_tp1_at,
        @atr14, @atr_pct_of_price, @regime, @resolve_note
      )
    `);
    const result = stmt.run(signalToParams(signal));
    if (result.changes === 0) {
      const again = findByPlanKey(signal.planKey);
      if (again) return again;
    }
    return signal;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[calibration] Failed to insert signal: ${msg}`);
  }
}

export function updateSignal(signal: LoggedSignal): void {
  const db = getDb();
  try {
    const stmt = db.prepare(`
      UPDATE signals SET
        timestamp=@timestamp, symbol=@symbol, mode=@mode, side=@side,
        entry=@entry, sl=@sl, tp1=@tp1, tp2=@tp2, tp3=@tp3,
        confidence=@confidence, win_chance_displayed=@win_chance_displayed,
        win_chance_calibrated=@win_chance_calibrated,
        confluence_pct=@confluence_pct, smc_score=@smc_score, ma_score=@ma_score,
        pa_score=@pa_score, bull_pts=@bull_pts, bear_pts=@bear_pts,
        htf_aligned=@htf_aligned, daily_bias=@daily_bias,
        conflicting_signals=@conflicting_signals, conflict_capped=@conflict_capped,
        outcome=@outcome, outcome_tp1=@outcome_tp1, resolved_at=@resolved_at,
        realized_r=@realized_r, realized_r_full=@realized_r_full,
        full_plan_closed=@full_plan_closed, tp2_hit=@tp2_hit, tp3_hit=@tp3_hit,
        sl_after_tp1=@sl_after_tp1, tp1_hit_at=@tp1_hit_at, tp2_hit_at=@tp2_hit_at,
        tp3_hit_at=@tp3_hit_at, sl_after_tp1_at=@sl_after_tp1_at,
        atr14=@atr14, atr_pct_of_price=@atr_pct_of_price, regime=@regime,
        resolve_note=@resolve_note
      WHERE id=@id
    `);
    stmt.run(signalToParams(signal));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[calibration] Failed to update signal id=${signal.id}: ${msg}`);
  }
}

export function listActiveSignalsForSymbol(symbol: string): LoggedSignal[] {
  const db = getDb();
  try {
    const rows = db
      .prepare(
        `SELECT * FROM signals WHERE symbol = ? AND (
          outcome = 'OPEN'
          OR (outcome_tp1 = 'WIN' AND full_plan_closed = 0)
        )`,
      )
      .all(symbol) as DbRow[];
    return rows.map(rowToSignal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[calibration] Failed to list active signals for ${symbol}: ${msg}`);
  }
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
