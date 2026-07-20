/**
 * One-shot: backup + dedupe live data/signals.db duplicate clusters.
 * Does NOT touch backtest DBs.
 */
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const DB_PATH = join(process.cwd(), "data", "signals.db");
const WINDOW_MS = 5 * 60 * 1000;
const BACKUP_PATH = join(
  process.cwd(),
  "data",
  `signals-dedup-backup-2026-07-20.csv`,
);

type Row = Record<string, unknown>;

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function outcomeRank(row: Row): number {
  const o = String(row.outcome ?? "OPEN");
  if (o === "TP1_HIT" || o === "SL_HIT") return 3;
  if (o !== "OPEN") return 2;
  if (row.outcome_tp1 != null && row.outcome_tp1 !== "") return 1;
  return 0;
}

function resolutionCompleteness(row: Row): number {
  let s = outcomeRank(row) * 100;
  if (row.resolved_at != null) s += 10;
  if (row.zone_touched_at != null) s += 5;
  if (Number(row.full_plan_closed) === 1) s += 5;
  if (row.realized_r != null) s += 2;
  if (row.realized_r_full != null) s += 2;
  return s;
}

const RESOLUTION_COLS = [
  "outcome",
  "outcome_tp1",
  "resolved_at",
  "realized_r",
  "realized_r_full",
  "full_plan_closed",
  "tp2_hit",
  "tp3_hit",
  "sl_after_tp1",
  "tp1_hit_at",
  "tp2_hit_at",
  "tp3_hit_at",
  "sl_after_tp1_at",
  "resolve_note",
  "zone_touched_at",
  "would_have_hit_sl_first",
  "liquidity_sweep_detected_at",
  "liquidity_sweep_then_regime_flipped",
  "trend_confirmed_at",
  "trend_duration_bars",
] as const;

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const cols = db.prepare("PRAGMA table_info(signals)").all() as {
  name: string;
}[];
const colNames = cols.map((c) => c.name);
const hasSource = colNames.includes("source");

console.log("=== STEP 1: schema ===");
console.log("columns:", colNames.join(", "));
console.log(
  "source/origin column:",
  hasSource ? "YES" : "NO — none (MigrationReport.source is unrelated)",
);

const before = (db.prepare("SELECT COUNT(*) AS n FROM signals").get() as { n: number })
  .n;
console.log("before total rows:", before);

const allRows = db
  .prepare(`SELECT * FROM signals ORDER BY symbol, mode, side, timestamp ASC`)
  .all() as Row[];

type Cluster = { members: Row[] };
const clusters: Cluster[] = [];
const used = new Set<string>();

for (let i = 0; i < allRows.length; i++) {
  const a = allRows[i];
  const aid = String(a.id);
  if (used.has(aid)) continue;

  const members: Row[] = [a];
  let changed = true;
  while (changed) {
    changed = false;
    const tMin = Math.min(...members.map((m) => Number(m.timestamp)));
    const tMax = Math.max(...members.map((m) => Number(m.timestamp)));
    for (const b of allRows) {
      if (String(b.symbol) !== String(a.symbol)) continue;
      if (String(b.mode) !== String(a.mode)) continue;
      if (String(b.side) !== String(a.side)) continue;
      if (members.some((m) => String(m.id) === String(b.id))) continue;
      if (
        Number(b.timestamp) < tMin - WINDOW_MS ||
        Number(b.timestamp) > tMax + WINDOW_MS
      )
        continue;
      if (
        !members.some(
          (m) => Math.abs(Number(b.timestamp) - Number(m.timestamp)) <= WINDOW_MS,
        )
      )
        continue;
      if (!members.some((m) => String(m.plan_key) !== String(b.plan_key))) continue;
      members.push(b);
      changed = true;
    }
  }

  const keys = new Set(members.map((m) => String(m.plan_key)));
  if (keys.size < 2) continue;
  for (const m of members) used.add(String(m.id));
  clusters.push({ members });
}

const clusteredRows = clusters.flatMap((c) => c.members);
console.log("=== STEP 2/3: clusters ===");
console.log("clusters:", clusters.length);
console.log("clustered rows:", clusteredRows.length);

// Backup CSV (all clustered rows, full columns)
const header = colNames.join(",");
const body = clusteredRows
  .map((r) => colNames.map((c) => csvEscape(r[c])).join(","))
  .join("\n");
writeFileSync(BACKUP_PATH, `${header}\n${body}\n`, "utf8");
console.log("backup written:", BACKUP_PATH);

console.log(
  "dedupe rule:",
  hasSource
    ? "keep alertBot-origin (source column)"
    : "KEEP EARLIEST by timestamp; merge better resolution onto kept row; delete rest",
);

const deleteIds: string[] = [];
const mergeLog: {
  keepId: string;
  deleted: string[];
  mergedFrom?: string;
  keepOutcome: string;
  finalOutcome: string;
}[] = [];

const updateStmt = db.prepare(
  `UPDATE signals SET ${RESOLUTION_COLS.map((c) => `${c} = @${c}`).join(", ")} WHERE id = @id`,
);
const deleteStmt = db.prepare(`DELETE FROM signals WHERE id = ?`);

const tx = db.transaction(() => {
  for (const { members } of clusters) {
    const sorted = [...members].sort(
      (a, b) => Number(a.timestamp) - Number(b.timestamp) || String(a.id).localeCompare(String(b.id)),
    );
    const keep = sorted[0];
    const rest = sorted.slice(1);
    const originalOutcome = String(keep.outcome);

    let donor: Row | null = null;
    let bestScore = resolutionCompleteness(keep);
    for (const r of rest) {
      const score = resolutionCompleteness(r);
      if (score > bestScore) {
        bestScore = score;
        donor = r;
      }
    }

    if (donor && resolutionCompleteness(donor) > resolutionCompleteness(keep)) {
      const params: Record<string, unknown> = { id: keep.id };
      for (const c of RESOLUTION_COLS) params[c] = donor[c];
      updateStmt.run(params);
      for (const c of RESOLUTION_COLS) keep[c] = donor[c];
    }

    for (const r of rest) {
      deleteIds.push(String(r.id));
      deleteStmt.run(String(r.id));
    }

    mergeLog.push({
      keepId: String(keep.id),
      deleted: rest.map((r) => String(r.id)),
      mergedFrom: donor ? String(donor.id) : undefined,
      keepOutcome: originalOutcome,
      finalOutcome: String(keep.outcome),
    });
  }
});

tx();

const after = (db.prepare("SELECT COUNT(*) AS n FROM signals").get() as { n: number }).n;
console.log("=== STEP 4 prep ===");
console.log("deleted rows:", deleteIds.length);
console.log("after total rows:", after);
console.log("expected ~", before - deleteIds.length);
console.log(
  "cluster actions:",
  JSON.stringify(mergeLog, null, 2),
);

db.close();
