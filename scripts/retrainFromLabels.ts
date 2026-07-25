/**
 * Rebuild model + playbook from existing labeled_20y.jsonl
 * (attach session/trend/vol, no full backtest re-run).
 *
 *   npx tsx scripts/retrainFromLabels.ts
 *   npx tsx scripts/retrainFromLabels.ts --file=data/XAU_5m_data.csv
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadHistoricalFile } from "../src/backtest/loadData";
import type { LearnRow } from "../src/learn/types";
import { attachMarketContext } from "../src/learn/marketContext";
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

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
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

function main() {
  const argv = process.argv.slice(2);
  const labelsPath =
    argValue(argv, "--labels") ?? join(LEARN_DIR, "labeled_20y.jsonl");
  const file = argValue(argv, "--file") ?? "data/XAU_5m_data.csv";

  if (!existsSync(labelsPath)) {
    console.error(`Missing ${labelsPath}`);
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`Missing ${file}`);
    process.exit(1);
  }

  console.log(`Loading labels ${labelsPath}…`);
  const rows = readFileSync(labelsPath, "utf8")
    .split(/\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LearnRow);
  console.log(`  ${rows.length} rows`);

  console.log(`Loading ${file} for market context…`);
  const loaded = loadHistoricalFile(file);
  attachMarketContext(rows, loaded.candles);
  const enriched = rows.filter((r) => r.session != null).length;
  console.log(`  enriched session/trend/vol on ${enriched}/${rows.length}`);

  writeFileSync(
    labelsPath,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );

  const playbook = buildScenarioPlaybook(rows);
  const moduleMarket = moduleMarketMatrix(rows);
  const tpWins = mineTpWins(rows);
  const model = trainLogisticSlModel(rows);
  saveModel(model);

  if (!existsSync(LEARN_DIR)) mkdirSync(LEARN_DIR, { recursive: true });
  const playbookPath = join(LEARN_DIR, "scenario_playbook.json");
  writeFileSync(
    playbookPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "retrain-from-labels",
        sampleN: rows.length,
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

  const overall = summarize(rows);
  const report = {
    trainedAt: model.trainedAt,
    source: "retrain-from-labels-20y",
    file,
    sampleN: rows.length,
    overall,
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
    note:
      "Cipher B / Fractal absent from this label set (prior year-filter bug). Re-run learn:20y with current code to include them.",
  };
  saveReport(report);
  writeFileSync(join(LEARN_DIR, "by_year_report.json"), JSON.stringify(report, null, 2));

  console.log(`
======== RETRAIN FROM LABELS ========
Samples     : ${rows.length}  (${overall.w}W / ${overall.l}L) WR ${overall.wr}%
Holdout acc : ${(model.metrics.accuracy * 100).toFixed(1)}%
Model       : ${MODEL_PATH}
Playbook    : ${playbookPath}
Report      : ${REPORT_PATH}
`);
  console.log("By module WR:");
  for (const [m, s] of Object.entries(overall.byMod).sort(
    (a, b) => b[1].w / (b[1].w + b[1].l) - a[1].w / (a[1].w + a[1].l),
  )) {
    const n = s.w + s.l;
    console.log(
      `  ${m}: ${((100 * s.w) / n).toFixed(1)}% (${s.w}W/${s.l}L n=${n})`,
    );
  }
  console.log("\nTop avoid:");
  for (const s of playbook.filter((p) => p.action === "avoid").slice(0, 6)) {
    console.log(`  [${s.rate}% SL] ${s.key} n=${s.n}`);
  }
  console.log("\nTop prefer:");
  for (const s of playbook.filter((p) => p.action === "prefer").slice(0, 6)) {
    console.log(`  [${s.wr}% WR] ${s.key} n=${s.n}`);
  }
  console.log("\nTop TP wins:");
  for (const c of tpWins.slice(0, 5)) {
    console.log(`  [${c.pctOfWins}%] ${c.label}`);
  }
  console.log("\nBest markets:");
  for (const c of [...moduleMarket]
    .filter((x) => x.verdict === "strong")
    .sort((a, b) => b.wr - a.wr)
    .slice(0, 5)) {
    console.log(`  [${c.wr}%] ${c.key} n=${c.n}`);
  }
  console.log("\nWorst markets:");
  for (const c of moduleMarket
    .filter((x) => x.verdict === "avoid" || x.verdict === "weak")
    .slice(0, 5)) {
    console.log(`  [${c.wr}%] ${c.key} (${c.verdict}) n=${c.n}`);
  }
  if (!overall.byMod.cipher_b && !overall.byMod.fractal) {
    console.log(
      "\nNOTE: Cipher B / Fractal not in labels — re-run learn:20y with current code to include them.",
    );
  }
}

main();
