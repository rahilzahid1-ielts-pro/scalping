/**
 * Weekly learn job — merge live EXECUTED trades into historical labels,
 * retrain SL model + playbook, overwrite only if sanity checks pass.
 *
 *   npm run learn:weekly
 *   npm run learn:weekly -- --live-days=90 --force
 *
 * Does NOT run full 20y backtest (too heavy for cron). Uses:
 *   data/learn/labeled_20y.jsonl (base) + live DB (recent days)
 * Optional: LEARN_WEEKLY_CSV_DIR for extra CSVs
 *
 * Sanity: keep previous model if new sample too small / WR insane / modules missing.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { buildHistoryPayload, karachiYmd } from "../src/history/apiHistory";
import { normalizeLearnModule, loadLearnRowsFromDir } from "../src/learn/csvImport";
import { attachMarketContext } from "../src/learn/marketContext";
import {
  buildScenarioPlaybook,
  mineTpWins,
  moduleMarketMatrix,
} from "../src/learn/scenarios";
import {
  LEARN_DIR,
  MODEL_PATH,
  REPORT_PATH,
  loadModel,
  saveModel,
  saveReport,
} from "../src/learn/modelStore";
import { trainLogisticSlModel } from "../src/learn/train";
import { resetLearnRuntimeCache } from "../src/learn/runtime";
import type { LearnRow } from "../src/learn/types";
import { loadHistoricalFile } from "../src/backtest/loadData";

const LABELS_PATH = join(LEARN_DIR, "labeled_20y.jsonl");
/** Git-friendly compressed base (~2.5MB vs ~25MB raw). */
const LABELS_GZ_PATH = join(LEARN_DIR, "labeled_20y.jsonl.gz");
const STAMP_PATH = join(LEARN_DIR, "last_weekly_run.json");
const PREV_MODEL = join(LEARN_DIR, "sl_model.prev.json");
const DEFAULT_CSV = "data/XAU_5m_data.csv";
const DAY_MS = 24 * 60 * 60 * 1000;

export type WeeklyLearnResult = {
  ok: boolean;
  skipped?: boolean;
  reason: string;
  sampleN?: number;
  wr?: number | null;
  liveAdded?: number;
  modelPath?: string;
};

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function ymdDaysAgo(days: number): string {
  const ms = Date.now() - days * DAY_MS;
  return karachiYmd(ms);
}

function loadJsonl(path: string): LearnRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LearnRow);
}

/** Prefer raw jsonl on volume; else gunzip the git-shipped .gz base. */
function loadBaseLabels(): LearnRow[] {
  if (existsSync(LABELS_PATH)) {
    return loadJsonl(LABELS_PATH);
  }
  if (existsSync(LABELS_GZ_PATH)) {
    const text = gunzipSync(readFileSync(LABELS_GZ_PATH)).toString("utf8");
    return text
      .split(/\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LearnRow);
  }
  return [];
}

async function rowsFromLive(from: string, to: string): Promise<LearnRow[]> {
  const hist = await buildHistoryPayload({ from, to, module: "all" });
  const out: LearnRow[] = [];
  for (const t of hist.trades) {
    if (!t.executed) continue;
    if (
      t.outcome !== "SL_HIT" &&
      t.outcome !== "TP1_HIT" &&
      t.outcome !== "TP2_HIT"
    ) {
      continue;
    }
    out.push({
      id: t.id,
      module: normalizeLearnModule(t.module),
      moduleLabel: t.moduleLabel,
      side: t.side,
      entry: t.entry,
      sl: t.sl,
      tp1: t.tp1,
      slMoney: Math.abs(t.slMoney) || Math.abs(t.entry - t.sl),
      tp1Money: Math.abs(t.tp1Money) || Math.abs(t.tp1 - t.entry),
      executedAt: t.executedAt ?? t.at,
      resolvedAt: t.resolvedAt,
      outcome: t.outcome as LearnRow["outcome"],
      realizedR: t.realizedR,
      pnlMoney: t.pnlMoney,
      source: "live-db",
    });
  }
  return out.filter((r) => r.module !== "scalp" && r.module !== "unknown");
}

function summarize(rows: LearnRow[]) {
  let w = 0;
  let l = 0;
  const mods = new Set<string>();
  for (const r of rows) {
    mods.add(r.module);
    if (r.outcome === "SL_HIT") l += 1;
    else w += 1;
  }
  const n = w + l;
  return {
    n,
    w,
    l,
    wr: n > 0 ? Math.round((w / n) * 1000) / 10 : null,
    moduleCount: mods.size,
  };
}

function sanityOk(
  rows: LearnRow[],
  prevSampleN: number | null,
): { ok: boolean; reason: string; sum: ReturnType<typeof summarize> } {
  const sum = summarize(rows);
  if (sum.n < 50) {
    return { ok: false, reason: `sampleN ${sum.n} < 50`, sum };
  }
  if (sum.moduleCount < 3) {
    return {
      ok: false,
      reason: `only ${sum.moduleCount} modules (need ≥3)`,
      sum,
    };
  }
  if (sum.wr != null && (sum.wr < 40 || sum.wr > 92)) {
    return {
      ok: false,
      reason: `WR ${sum.wr}% outside 40–92 (likely bad merge)`,
      sum,
    };
  }
  if (prevSampleN != null && prevSampleN >= 100 && sum.n < prevSampleN * 0.5) {
    return {
      ok: false,
      reason: `sample collapsed ${prevSampleN} → ${sum.n}`,
      sum,
    };
  }
  return { ok: true, reason: "ok", sum };
}

/** Core weekly job — safe to call from CLI or daemon. */
export async function runWeeklyLearn(opts?: {
  liveDays?: number;
  csvFile?: string;
  csvDir?: string;
  force?: boolean;
  log?: (...args: unknown[]) => void;
}): Promise<WeeklyLearnResult> {
  const log = opts?.log ?? console.log;
  const liveDays = opts?.liveDays ?? Number(process.env.LEARN_WEEKLY_LIVE_DAYS ?? 90);
  const csvFile = opts?.csvFile ?? process.env.LEARN_WEEKLY_OHLC ?? DEFAULT_CSV;
  const csvDir =
    opts?.csvDir ?? process.env.LEARN_WEEKLY_CSV_DIR ?? "";
  const force = opts?.force ?? false;

  if (!existsSync(LEARN_DIR)) mkdirSync(LEARN_DIR, { recursive: true });

  const prev = loadModel();
  const base = loadBaseLabels();
  log(
    `[weekly-learn] base labels=${base.length} prevModel sampleN=${prev?.sampleN ?? "n/a"}`,
  );

  const to = karachiYmd();
  const from = ymdDaysAgo(Math.max(7, liveDays));
  log(`[weekly-learn] live window ${from} → ${to} (${liveDays}d)…`);
  let live: LearnRow[] = [];
  try {
    live = await rowsFromLive(from, to);
  } catch (e) {
    log(
      "[weekly-learn] live load failed:",
      e instanceof Error ? e.message : e,
    );
  }
  log(`[weekly-learn] live rows=${live.length}`);

  let csvExtra: LearnRow[] = [];
  if (csvDir && existsSync(csvDir)) {
    csvExtra = loadLearnRowsFromDir(csvDir).filter(
      (r) => r.module !== "scalp" && r.module !== "unknown",
    );
    log(`[weekly-learn] csv dir rows=${csvExtra.length}`);
  }

  const byId = new Map<string, LearnRow>();
  for (const r of [...base, ...csvExtra, ...live]) {
    byId.set(r.id, r);
  }
  let merged = [...byId.values()].sort((a, b) => a.executedAt - b.executedAt);

  if (merged.length < 50 && !force) {
    return {
      ok: false,
      skipped: true,
      reason:
        "Not enough labels — add data/learn/labeled_20y.jsonl.gz (git) or .jsonl on volume, or wait for more live fills",
      sampleN: merged.length,
      liveAdded: live.length,
    };
  }

  if (existsSync(csvFile)) {
    try {
      log(`[weekly-learn] attach market context from ${csvFile}…`);
      const loaded = loadHistoricalFile(csvFile);
      attachMarketContext(merged, loaded.candles);
    } catch (e) {
      log(
        "[weekly-learn] market context skip:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  const check = sanityOk(merged, prev?.sampleN ?? null);
  if (!check.ok && !force) {
    return {
      ok: false,
      skipped: true,
      reason: `sanity fail: ${check.reason} — kept previous model`,
      sampleN: check.sum.n,
      wr: check.sum.wr,
      liveAdded: live.length,
    };
  }

  log(
    `[weekly-learn] training n=${check.sum.n} WR=${check.sum.wr}% modules=${check.sum.moduleCount}…`,
  );
  const model = trainLogisticSlModel(merged);
  const playbook = buildScenarioPlaybook(merged);
  const moduleMarket = moduleMarketMatrix(merged);
  const tpWins = mineTpWins(merged);

  if (existsSync(MODEL_PATH)) {
    copyFileSync(MODEL_PATH, PREV_MODEL);
  }
  saveModel(model);

  writeFileSync(
    join(LEARN_DIR, "scenario_playbook.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "weekly-learn",
        sampleN: merged.length,
        liveDays,
        liveAdded: live.length,
        rule:
          "avoid = SL≥40% (n≥25); throttle ≥30%; prefer = WR≥72% (n≥40).",
        scenarios: playbook.slice(0, 100),
        moduleMarket: {
          worst: moduleMarket
            .filter((c) => c.verdict === "avoid" || c.verdict === "weak")
            .slice(0, 25),
          best: [...moduleMarket]
            .filter((c) => c.verdict === "strong" || c.verdict === "ok")
            .sort((a, b) => b.wr - a.wr || b.n - a.n)
            .slice(0, 25),
        },
        tpWins: tpWins.slice(0, 10),
      },
      null,
      2,
    ),
  );

  writeFileSync(
    LABELS_PATH,
    merged.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );

  const report = {
    trainedAt: model.trainedAt,
    source: "weekly-learn",
    liveFrom: from,
    liveTo: to,
    liveDays,
    liveAdded: live.length,
    sampleN: merged.length,
    overall: check.sum,
    metrics: model.metrics,
    slCauses: model.slCauses.slice(0, 8),
    tpWins: model.tpWins.slice(0, 6),
    sanity: check.reason,
    modelPath: MODEL_PATH,
  };
  saveReport(report);
  writeFileSync(join(LEARN_DIR, "by_year_report.json"), JSON.stringify(report, null, 2));

  const stamp = {
    at: Date.now(),
    atIso: new Date().toISOString(),
    sampleN: merged.length,
    wr: check.sum.wr,
    liveAdded: live.length,
    ok: true,
  };
  writeFileSync(STAMP_PATH, JSON.stringify(stamp, null, 2));
  resetLearnRuntimeCache();

  log(
    `[weekly-learn] OK n=${merged.length} WR=${check.sum.wr}% live+${live.length} → ${MODEL_PATH}`,
  );
  return {
    ok: true,
    reason: "trained",
    sampleN: merged.length,
    wr: check.sum.wr,
    liveAdded: live.length,
    modelPath: MODEL_PATH,
  };
}

export function daysSinceLastWeeklyRun(): number | null {
  if (!existsSync(STAMP_PATH)) return null;
  try {
    const s = JSON.parse(readFileSync(STAMP_PATH, "utf8")) as { at?: number };
    if (!s.at) return null;
    return (Date.now() - s.at) / DAY_MS;
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage:
  npm run learn:weekly
  npm run learn:weekly -- --live-days=90
  npm run learn:weekly -- --force

Env: LEARN_WEEKLY_LIVE_DAYS, LEARN_WEEKLY_OHLC, LEARN_WEEKLY_CSV_DIR
Enable daemon: ENABLE_WEEKLY_LEARN=1 (or auto on Railway)`);
    return;
  }
  const result = await runWeeklyLearn({
    liveDays: Number(argValue(argv, "--live-days") ?? 90),
    force: hasFlag(argv, "--force"),
  });
  if (!result.ok) {
    console.error("[weekly-learn]", result.reason);
    process.exit(result.skipped ? 0 : 1);
  }
  console.log("[weekly-learn] done", result);
  console.log("Report:", REPORT_PATH);
}

const isDirect = process.argv[1]?.replace(/\\/g, "/").endsWith("learnWeekly.ts");
if (isDirect) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
