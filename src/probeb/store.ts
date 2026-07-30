/**
 * Probeb persistence — next-candle predictions + daily accuracy.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { karachiYmd } from "../history/apiHistory";
import {
  m5FloorMs,
  type ProbebPrediction,
  type ProbebSide,
} from "../strategies/probebEngine";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA_DIR = join(ROOT, "data");
export const LIVE_DB_PATH = join(DATA_DIR, "signals.db");

export type ProbebRow = {
  id: string;
  barTime: number;
  predictedSide: ProbebSide;
  probabilityPct: number;
  confidencePct: number;
  bucket: string;
  sampleN: number;
  reason: string;
  actualSide: ProbebSide | null;
  correct: number | null;
  dayKey: string;
  resolvedAt: number | null;
  createdAt: number;
  source: "live" | "backtest";
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS probeb_predictions (
  id               TEXT PRIMARY KEY,
  bar_time         INTEGER NOT NULL,
  predicted_side   TEXT NOT NULL,
  probability_pct  REAL NOT NULL,
  confidence_pct   REAL NOT NULL,
  bucket           TEXT NOT NULL DEFAULT '',
  sample_n         INTEGER NOT NULL DEFAULT 0,
  reason           TEXT NOT NULL DEFAULT '[]',
  actual_side      TEXT,
  correct          INTEGER,
  day_key          TEXT NOT NULL,
  resolved_at      INTEGER,
  created_at       INTEGER NOT NULL,
  source           TEXT NOT NULL DEFAULT 'live'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_probeb_bar ON probeb_predictions(bar_time, source);
CREATE INDEX IF NOT EXISTS idx_probeb_day ON probeb_predictions(day_key);
CREATE INDEX IF NOT EXISTS idx_probeb_pending ON probeb_predictions(actual_side);
`;

let liveDb: Database.Database | null = null;

function openDb(path: string): Database.Database {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("application_id = 0x50524f42"); // 'PROB'
  db.exec(SCHEMA);
  return db;
}

export function getLiveProbebDb(): Database.Database {
  if (!liveDb) liveDb = openDb(LIVE_DB_PATH);
  return liveDb;
}

function rowFromDb(r: Record<string, unknown>): ProbebRow {
  return {
    id: String(r.id),
    barTime: Number(r.bar_time),
    predictedSide: r.predicted_side as ProbebSide,
    probabilityPct: Number(r.probability_pct),
    confidencePct: Number(r.confidence_pct),
    bucket: String(r.bucket ?? ""),
    sampleN: Number(r.sample_n ?? 0),
    reason: String(r.reason ?? "[]"),
    actualSide: r.actual_side ? (r.actual_side as ProbebSide) : null,
    correct: r.correct == null ? null : Number(r.correct),
    dayKey: String(r.day_key),
    resolvedAt: r.resolved_at == null ? null : Number(r.resolved_at),
    createdAt: Number(r.created_at),
    source: (r.source as "live" | "backtest") ?? "live",
  };
}

export function predictionToRow(
  pred: ProbebPrediction,
  source: "live" | "backtest" = "live",
): ProbebRow {
  const createdAt = Date.now();
  const barTime = m5FloorMs(pred.barTime);
  return {
    id: `probeb-${barTime}`,
    barTime,
    predictedSide: pred.side,
    probabilityPct: pred.probabilityPct,
    confidencePct: pred.confidencePct,
    bucket: pred.bucket,
    sampleN: pred.sampleN,
    reason: JSON.stringify(pred.reason),
    actualSide: null,
    correct: null,
    dayKey: karachiYmd(barTime),
    resolvedAt: null,
    createdAt,
    source,
  };
}

export function insertProbebRow(db: Database.Database, row: ProbebRow): void {
  db.prepare(
    `INSERT OR IGNORE INTO probeb_predictions (
      id, bar_time, predicted_side, probability_pct, confidence_pct,
      bucket, sample_n, reason, actual_side, correct, day_key,
      resolved_at, created_at, source
    ) VALUES (
      @id, @barTime, @predictedSide, @probabilityPct, @confidencePct,
      @bucket, @sampleN, @reason, @actualSide, @correct, @dayKey,
      @resolvedAt, @createdAt, @source
    )`,
  ).run(row);
}

/** Replace a still-pending live prediction (spike scrub / wrong lock repair). */
export function replacePendingProbeb(
  db: Database.Database,
  row: ProbebRow,
): boolean {
  const info = db
    .prepare(
      `UPDATE probeb_predictions
       SET predicted_side = @predictedSide,
           probability_pct = @probabilityPct,
           confidence_pct = @confidencePct,
           bucket = @bucket,
           sample_n = @sampleN,
           reason = @reason,
           created_at = @createdAt
       WHERE id = @id AND source = 'live' AND actual_side IS NULL`,
    )
    .run(row);
  return Number(info.changes) > 0;
}

export function listPendingProbeb(db: Database.Database): ProbebRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM probeb_predictions
       WHERE actual_side IS NULL AND source = 'live'
       ORDER BY bar_time ASC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowFromDb);
}

/** Drop polluted rows (non M5-aligned bar_time) — old live-rebase spam. */
export function purgeUnstablePending(db: Database.Database): number {
  const info = db
    .prepare(
      `DELETE FROM probeb_predictions
       WHERE source = 'live' AND (bar_time % 300000) != 0`,
    )
    .run();
  return Number(info.changes ?? 0);
}

/** Keep one row per floored M5 for UI (prefer resolved, else latest). */
export function listRecentProbebDeduped(
  db: Database.Database,
  limit = 20,
): ProbebRow[] {
  const rows = listRecentProbeb(db, limit * 4);
  const seen = new Set<number>();
  const out: ProbebRow[] = [];
  for (const r of rows) {
    const flo = m5FloorMs(r.barTime);
    if (seen.has(flo)) continue;
    seen.add(flo);
    out.push({ ...r, barTime: flo });
    if (out.length >= limit) break;
  }
  return out;
}

export function getPendingProbeb(db: Database.Database): ProbebRow | null {
  const rows = listPendingProbeb(db);
  return rows.length ? rows[rows.length - 1] : null;
}

export function getLatestProbeb(db: Database.Database): ProbebRow | null {
  const r = db
    .prepare(
      `SELECT * FROM probeb_predictions WHERE source = 'live'
       ORDER BY bar_time DESC LIMIT 1`,
    )
    .get() as Record<string, unknown> | undefined;
  return r ? rowFromDb(r) : null;
}

export function resolveProbeb(
  db: Database.Database,
  id: string,
  actualSide: ProbebSide,
  resolvedAt = Date.now(),
): void {
  const row = db
    .prepare(`SELECT predicted_side FROM probeb_predictions WHERE id = ?`)
    .get(id) as { predicted_side: string } | undefined;
  if (!row) return;
  const correct = row.predicted_side === actualSide ? 1 : 0;
  db.prepare(
    `UPDATE probeb_predictions
     SET actual_side = @actualSide, correct = @correct, resolved_at = @resolvedAt
     WHERE id = @id AND actual_side IS NULL`,
  ).run({ id, actualSide, correct, resolvedAt });
}

/** Re-write ACTUAL/correct even if already settled (body-color fix repair). */
export function forceResolveProbeb(
  db: Database.Database,
  id: string,
  actualSide: ProbebSide,
  resolvedAt = Date.now(),
): void {
  const row = db
    .prepare(`SELECT predicted_side FROM probeb_predictions WHERE id = ?`)
    .get(id) as { predicted_side: string } | undefined;
  if (!row) return;
  const correct = row.predicted_side === actualSide ? 1 : 0;
  db.prepare(
    `UPDATE probeb_predictions
     SET actual_side = @actualSide, correct = @correct, resolved_at = @resolvedAt
     WHERE id = @id`,
  ).run({ id, actualSide, correct, resolvedAt });
}

export type DayAccuracy = {
  dayKey: string;
  resolved: number;
  correct: number;
  wrong: number;
  accuracyPct: number | null;
  /** High-confidence subset (conf ≥ 40). */
  hiResolved: number;
  hiCorrect: number;
  hiWrong: number;
  hiAccuracyPct: number | null;
};

export function dayAccuracy(
  db: Database.Database,
  dayKey: string,
  source: "live" | "backtest" = "live",
): DayAccuracy {
  const rows = db
    .prepare(
      `SELECT correct, confidence_pct FROM probeb_predictions
       WHERE day_key = ? AND source = ? AND correct IS NOT NULL`,
    )
    .all(dayKey, source) as { correct: number; confidence_pct: number }[];

  let resolved = 0;
  let correct = 0;
  let hiResolved = 0;
  let hiCorrect = 0;
  for (const r of rows) {
    resolved += 1;
    if (r.correct === 1) correct += 1;
    if (r.confidence_pct >= 40) {
      hiResolved += 1;
      if (r.correct === 1) hiCorrect += 1;
    }
  }
  const wrong = resolved - correct;
  const hiWrong = hiResolved - hiCorrect;
  return {
    dayKey,
    resolved,
    correct,
    wrong,
    accuracyPct:
      resolved > 0 ? Math.round((correct / resolved) * 1000) / 10 : null,
    hiResolved,
    hiCorrect,
    hiWrong,
    hiAccuracyPct:
      hiResolved > 0
        ? Math.round((hiCorrect / hiResolved) * 1000) / 10
        : null,
  };
}

export function listRecentProbeb(
  db: Database.Database,
  limit = 20,
): ProbebRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM probeb_predictions WHERE source = 'live'
       ORDER BY bar_time DESC LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowFromDb);
}

export function lifetimeAccuracy(db: Database.Database): {
  resolved: number;
  correct: number;
  accuracyPct: number | null;
} {
  const r = db
    .prepare(
      `SELECT
         COUNT(*) AS n,
         SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS c
       FROM probeb_predictions
       WHERE source = 'live' AND correct IS NOT NULL`,
    )
    .get() as { n: number; c: number };
  const resolved = Number(r?.n ?? 0);
  const correct = Number(r?.c ?? 0);
  return {
    resolved,
    correct,
    accuracyPct:
      resolved > 0 ? Math.round((correct / resolved) * 1000) / 10 : null,
  };
}
