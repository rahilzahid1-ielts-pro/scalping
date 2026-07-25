/**
 * Year-chunk 20y learn: backtest each calendar year (no Scalp) →
 * scenario playbook + SL/TP causes + module×market + trained model.
 *
 *   npm run learn:20y -- --file=data/XAU_5m_data.csv --from=2005 --to=2025
 *   npm run learn:20y -- --file=data/XAU_5m_data.csv --from=2023 --to=2025
 *
 * Full 2005–2025 ≈ 1–2 hours. Start with a short range first.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadHistoricalFile } from "../src/backtest/loadData";
import type { Candle } from "../src/types";
import type { LearnRow } from "../src/learn/types";
import { mineSlCauses } from "../src/learn/explain";
import {
  buildScenarioPlaybook,
  mineTpWins,
  moduleMarketMatrix,
} from "../src/learn/scenarios";
import { trainLogisticSlModel } from "../src/learn/train";
import {
  LEARN_DIR,
  MODEL_PATH,
  REPORT_PATH,
  saveModel,
  saveReport,
} from "../src/learn/modelStore";
import { collectNoScalpLabels } from "./learnFromBacktest";

const DEFAULT_FILE = "data/XAU_5m_data.csv";
const DAY_MS = 24 * 60 * 60 * 1000;
const WARMUP_MS = 120 * DAY_MS;

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

function sliceYear(all: Candle[], year: number): { candles: Candle[]; days: number } {
  const yearStart = Date.UTC(year, 0, 1);
  const yearEnd = Date.UTC(year, 11, 31, 23, 59, 59);
  const candles = all.filter(
    (c) => c.time >= yearStart - WARMUP_MS && c.time <= yearEnd,
  );
  const days = Math.max(60, Math.ceil((yearEnd - yearStart) / DAY_MS) + 2);
  return { candles, days };
}

function inYear(ms: number, year: number): boolean {
  const d = new Date(ms);
  return d.getUTCFullYear() === year;
}

function summarize(rows: LearnRow[]) {
  const byMod: Record<string, { w: number; l: number }> = {};
  let w = 0;
  let l = 0;
  for (const r of rows) {
    byMod[r.module] ??= { w: 0, l: 0 };
    if (r.outcome === "SL_HIT") {
      byMod[r.module].l += 1;
      l += 1;
    } else {
      byMod[r.module].w += 1;
      w += 1;
    }
  }
  const n = w + l;
  return {
    n,
    w,
    l,
    wr: n > 0 ? Math.round((w / n) * 1000) / 10 : null,
    byMod,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage:
  npm run learn:20y -- --file=data/XAU_5m_data.csv --from=2005 --to=2025
  npm run learn:20y -- --from=2023 --to=2025          # short pilot (~12–15 min)
  npm run learn:20y -- --from=2005 --to=2025 --spread=0.25

No Scalp. Year chunks → scenario_playbook.json + sl_model.json
(SL causes + TP wins + module×market). ETA ~3–5 min per year.`);
    return;
  }
  const file = argValue(argv, "--file") ?? DEFAULT_FILE;
  const fromY = Number(argValue(argv, "--from") ?? 2005);
  const toY = Number(argValue(argv, "--to") ?? 2025);
  const spread = Number(argValue(argv, "--spread") ?? 0.25);

  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }
  if (!(fromY <= toY) || fromY < 1990 || toY > 2030) {
    console.error("Use --from=YYYY --to=YYYY (e.g. 2005 2025)");
    process.exit(1);
  }

  console.log(`Loading ${file} (full series once)…`);
  const tLoad = Date.now();
  const loaded = loadHistoricalFile(file);
  console.log(
    `Loaded ${loaded.quality.bars} bars in ${((Date.now() - tLoad) / 1000).toFixed(1)}s`,
  );
  console.log(`Range: ${loaded.quality.firstIso} → ${loaded.quality.lastIso}`);
  console.log(
    `Year chunks ${fromY}→${toY} · no Scalp · spread=${spread}`,
  );
  console.log(
    `ETA rough: ~3–5 min/year × ${toY - fromY + 1} ≈ ${((toY - fromY + 1) * 4).toFixed(0)} min\n`,
  );

  const allLabels: LearnRow[] = [];
  const byYear: Record<
    string,
    ReturnType<typeof summarize> & { topCauses: { id: string; pct: number }[] }
  > = {};

  for (let y = fromY; y <= toY; y++) {
    const { candles, days } = sliceYear(loaded.candles, y);
    if (candles.length < 5000) {
      console.log(`\n==== ${y} SKIP (only ${candles.length} bars) ====`);
      continue;
    }
    console.log(`\n==== YEAR ${y} · ${candles.length} bars · days≈${days} ====`);
    const t0 = Date.now();
    const rows = collectNoScalpLabels(candles, days, spread, console.log);
    const yearRows = rows.filter((r) => inYear(r.executedAt, y));
    allLabels.push(...yearRows);
    const sum = summarize(yearRows);
    const causes = mineSlCauses(yearRows)
      .slice(0, 4)
      .map((c) => ({ id: c.id, pct: c.pctOfLosses }));
    byYear[String(y)] = { ...sum, topCauses: causes };
    console.log(
      `  YEAR ${y} done: ${sum.n} labels · WR ${sum.wr ?? "n/a"}% · ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    );
  }

  allLabels.sort((a, b) => a.executedAt - b.executedAt);
  // Dedup by id
  const seen = new Set<string>();
  const unique = allLabels.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  if (!existsSync(LEARN_DIR)) mkdirSync(LEARN_DIR, { recursive: true });
  const labelsPath = join(LEARN_DIR, "labeled_20y.jsonl");
  writeFileSync(
    labelsPath,
    unique.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );

  console.log(`\nTotal unique labels: ${unique.length}`);
  if (unique.length < 20) {
    console.error("Not enough labels — widen --from/--to or check CSV.");
    process.exit(1);
  }

  const playbook = buildScenarioPlaybook(unique);
  const moduleMarket = moduleMarketMatrix(unique);
  const tpWins = mineTpWins(unique);
  const playbookPath = join(LEARN_DIR, "scenario_playbook.json");
  writeFileSync(
    playbookPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        from: fromY,
        to: toY,
        sampleN: unique.length,
        rule:
          "avoid = SL≥40% (n≥25); throttle ≥30%; prefer = WR≥72% (n≥40). Combine with lean cooldown / post-TP pause.",
        scenarios: playbook.slice(0, 100),
        moduleMarket: {
          worst: moduleMarket.filter((c) => c.verdict === "avoid" || c.verdict === "weak").slice(0, 25),
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

  const model = trainLogisticSlModel(unique);
  saveModel(model);

  const overall = summarize(unique);
  const report = {
    trainedAt: model.trainedAt,
    source: "backtest-m5-20y-chunks",
    file,
    from: fromY,
    to: toY,
    spread,
    exclude: ["scalp"],
    sampleN: unique.length,
    overall,
    byYear,
    metrics: model.metrics,
    slCauses: model.slCauses,
    tpWins: model.tpWins,
    moduleMarketBest: [...moduleMarket]
      .filter((c) => c.verdict === "strong")
      .sort((a, b) => b.wr - a.wr)
      .slice(0, 15),
    moduleMarketWorst: moduleMarket
      .filter((c) => c.verdict === "avoid" || c.verdict === "weak")
      .slice(0, 15),
    playbookTop: playbook.slice(0, 20),
    labelsPath,
    playbookPath,
    modelPath: MODEL_PATH,
  };
  saveReport(report);
  writeFileSync(join(LEARN_DIR, "by_year_report.json"), JSON.stringify(report, null, 2));

  console.log(`
======== LEARN 20Y CHUNKS ========
Years       : ${fromY} → ${toY}
Samples     : ${unique.length}  (${overall.w}W / ${overall.l}L) WR ${overall.wr}%
Holdout acc : ${(model.metrics.accuracy * 100).toFixed(1)}%
Model       : ${MODEL_PATH}
Playbook    : ${playbookPath}
By-year     : ${join(LEARN_DIR, "by_year_report.json")}
Report      : ${REPORT_PATH}
`);

  console.log("By module WR:");
  for (const [m, s] of Object.entries(overall.byMod).sort(
    (a, b) => b[1].w / (b[1].w + b[1].l) - a[1].w / (a[1].w + a[1].l),
  )) {
    const n = s.w + s.l;
    const wr = n ? ((100 * s.w) / n).toFixed(1) : "n/a";
    console.log(`  ${m}: ${wr}% (${s.w}W/${s.l}L n=${n})`);
  }

  console.log("\nTop avoid scenarios:");
  for (const s of playbook.filter((p) => p.action === "avoid").slice(0, 8)) {
    console.log(`  [${s.rate}% SL] ${s.key} n=${s.n} → ${s.tip}`);
  }
  console.log("\nTop prefer scenarios:");
  for (const s of playbook.filter((p) => p.action === "prefer").slice(0, 6)) {
    console.log(`  [${s.wr}% WR] ${s.key} n=${s.n} → ${s.tip}`);
  }
  console.log("\nTop SL causes:");
  for (const c of model.slCauses.slice(0, 6)) {
    console.log(`  [${c.pctOfLosses}%] ${c.label} n=${c.n} → ${c.fix}`);
  }
  console.log("\nTop TP win patterns:");
  for (const c of tpWins.slice(0, 6)) {
    console.log(`  [${c.pctOfWins}%] ${c.label} n=${c.n} → ${c.tip}`);
  }
  console.log("\nBest module×market:");
  for (const c of [...moduleMarket]
    .filter((x) => x.verdict === "strong")
    .sort((a, b) => b.wr - a.wr)
    .slice(0, 6)) {
    console.log(`  [${c.wr}% WR] ${c.key} n=${c.n} (${c.verdict})`);
  }
  console.log("\nWorst module×market:");
  for (const c of moduleMarket
    .filter((x) => x.verdict === "avoid" || x.verdict === "weak")
    .slice(0, 6)) {
    console.log(`  [${c.wr}% WR] ${c.key} n=${c.n} (${c.verdict})`);
  }
}

const isDirect = process.argv[1]?.replace(/\\/g, "/").endsWith("learnFrom20y.ts");
if (isDirect) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
