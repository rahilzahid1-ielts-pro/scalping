/**
 * Read-only: find same symbol+mode+side locks with distinct plan_keys
 * inside a 5-minute window (likely browser vs alertBot dual-write).
 */
import Database from "better-sqlite3";
import { join } from "node:path";

const DB = join(process.cwd(), "data", "signals.db");
const WINDOW_MS = 5 * 60 * 1000;

type Row = {
  id: string;
  timestamp: number;
  symbol: string;
  mode: string;
  side: string;
  plan_key: string;
  entry: number;
  sl: number;
  tp1: number;
};

const db = new Database(DB, { readonly: true });
const total = (db.prepare("SELECT COUNT(*) AS n FROM signals").get() as { n: number }).n;
const bySymbolMode = db
  .prepare(
    `SELECT symbol, mode, COUNT(*) AS n FROM signals GROUP BY symbol, mode ORDER BY symbol, mode`,
  )
  .all() as { symbol: string; mode: string; n: number }[];

const rows = db
  .prepare(
    `SELECT id, timestamp, symbol, mode, side, plan_key, entry, sl, tp1
     FROM signals
     ORDER BY symbol, mode, side, timestamp ASC`,
  )
  .all() as Row[];

type Cluster = {
  symbol: string;
  mode: string;
  side: string;
  t0: number;
  t1: number;
  n: number;
  planKeys: string[];
  entries: number[];
};

const clusters: Cluster[] = [];
const used = new Set<string>(); // row ids already assigned to a cluster

for (let i = 0; i < rows.length; i++) {
  const a = rows[i];
  if (used.has(a.id)) continue;

  const members: Row[] = [a];
  for (let j = i + 1; j < rows.length; j++) {
    const b = rows[j];
    if (b.symbol !== a.symbol || b.mode !== a.mode || b.side !== a.side) break;
    if (b.timestamp - a.timestamp > WINDOW_MS) break;
    if (b.plan_key === a.plan_key) continue;
    // distinct plan_key within window of anchor a
    members.push(b);
  }

  // Expand: any distinct plan_key rows that pairwise fall in a connected
  // component under "same group + |Δt| <= 5m". Greedy: start from a, add all
  // same-group rows within 5m of any member that have a new plan_key.
  let changed = true;
  while (changed) {
    changed = false;
    const tMin = Math.min(...members.map((m) => m.timestamp));
    const tMax = Math.max(...members.map((m) => m.timestamp));
    for (let j = 0; j < rows.length; j++) {
      const b = rows[j];
      if (b.symbol !== a.symbol || b.mode !== a.mode || b.side !== a.side) continue;
      if (members.some((m) => m.id === b.id)) continue;
      if (b.timestamp < tMin - WINDOW_MS || b.timestamp > tMax + WINDOW_MS) continue;
      // Must be within WINDOW of at least one member
      if (!members.some((m) => Math.abs(b.timestamp - m.timestamp) <= WINDOW_MS)) continue;
      if (!members.some((m) => m.plan_key !== b.plan_key)) continue;
      members.push(b);
      changed = true;
    }
  }

  const distinctKeys = new Set(members.map((m) => m.plan_key));
  if (distinctKeys.size < 2) continue;

  for (const m of members) used.add(m.id);

  clusters.push({
    symbol: a.symbol,
    mode: a.mode,
    side: a.side,
    t0: Math.min(...members.map((m) => m.timestamp)),
    t1: Math.max(...members.map((m) => m.timestamp)),
    n: members.length,
    planKeys: [...distinctKeys],
    entries: members.map((m) => m.entry),
  });
}

const rowsInClusters = clusters.reduce((s, c) => s + c.n, 0);
const excessDupes = clusters.reduce((s, c) => s + (c.n - 1), 0);

const xauClusters = clusters.filter((c) => c.symbol === "XAUUSD");
const xauRows = rows.filter((r) => r.symbol === "XAUUSD").length;
const xauClusterRows = xauClusters.reduce((s, c) => s + c.n, 0);
const xauExcess = xauClusters.reduce((s, c) => s + (c.n - 1), 0);

console.log(
  JSON.stringify(
    {
      totalRows: total,
      bySymbolMode,
      windowMs: WINDOW_MS,
      duplicateClusters: clusters.length,
      rowsInDuplicateClusters: rowsInClusters,
      excessRowsBeyondOnePerCluster: excessDupes,
      pctOfTotalRowsInClusters: total
        ? +((100 * rowsInClusters) / total).toFixed(2)
        : 0,
      pctExcessOfTotal: total ? +((100 * excessDupes) / total).toFixed(2) : 0,
      xauOnly: {
        totalRows: xauRows,
        duplicateClusters: xauClusters.length,
        rowsInClusters: xauClusterRows,
        excessRows: xauExcess,
        pctRowsInClusters: xauRows
          ? +((100 * xauClusterRows) / xauRows).toFixed(2)
          : 0,
        pctExcessOfXau: xauRows ? +((100 * xauExcess) / xauRows).toFixed(2) : 0,
      },
      vs292Baseline: {
        note: "M5 backtest 292 locks are walk-forward synthetic and are NOT written to signals.db — cannot % against 292 live rows",
        liveTotal: total,
      },
      byMode: Object.fromEntries(
        ["scalping", "intraday"].map((mode) => {
          const cs = clusters.filter((c) => c.mode === mode);
          return [
            mode,
            {
              clusters: cs.length,
              rows: cs.reduce((s, c) => s + c.n, 0),
              excess: cs.reduce((s, c) => s + (c.n - 1), 0),
            },
          ];
        }),
      ),
      sampleClusters: clusters.slice(0, 8).map((c) => ({
        ...c,
        spanSec: +((c.t1 - c.t0) / 1000).toFixed(1),
        iso: new Date(c.t0).toISOString(),
      })),
    },
    null,
    2,
  ),
);

db.close();
