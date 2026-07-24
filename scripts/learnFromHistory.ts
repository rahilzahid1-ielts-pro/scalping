/**
 * Train SL-risk model from past Trade History CSVs (or live history DB).
 *
 *   npm run learn -- --dir=D:/download
 *   npm run learn -- --dir=D:/download --from=2026-07-21 --to=2026-07-25
 *   npm run learn -- --live --from=2026-07-22 --to=2026-07-25
 *
 * Writes: data/learn/sl_model.json + data/learn/last_report.json
 */
import { existsSync } from "node:fs";
import { buildHistoryPayload } from "../src/history/apiHistory";
import {
  loadLearnRowsFromDir,
  normalizeLearnModule,
} from "../src/learn/csvImport";
import { saveModel, saveReport, MODEL_PATH, REPORT_PATH } from "../src/learn/modelStore";
import { trainLogisticSlModel } from "../src/learn/train";
import type { LearnRow } from "../src/learn/types";

function argValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

async function rowsFromLive(from: string, to: string): Promise<LearnRow[]> {
  const hist = await buildHistoryPayload({ from, to, module: "all" });
  const out: LearnRow[] = [];
  for (const t of hist.trades) {
    if (!t.executed) continue;
    if (t.outcome !== "SL_HIT" && t.outcome !== "TP1_HIT" && t.outcome !== "TP2_HIT") {
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
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const dir = argValue(argv, "--dir") ?? "D:/download";
  const from = argValue(argv, "--from");
  const to = argValue(argv, "--to");
  const useLive = hasFlag(argv, "--live");

  let rows: LearnRow[] = [];
  if (useLive) {
    const f = from ?? "2026-07-01";
    const t = to ?? from ?? "2026-07-25";
    console.log(`Loading LIVE history ${f} → ${t}…`);
    rows = await rowsFromLive(f, t);
  } else {
    if (!existsSync(dir)) {
      console.error(`Dir not found: ${dir}`);
      console.error("Put trade-history-*.csv there, or pass --dir=...");
      process.exit(1);
    }
    console.log(`Loading CSVs from ${dir}…`);
    rows = loadLearnRowsFromDir(dir);
  }

  if (from || to) {
    const f = from ? Date.parse(from + "T00:00:00+05:00") : 0;
    const t = to ? Date.parse(to + "T23:59:59+05:00") : Number.MAX_SAFE_INTEGER;
    rows = rows.filter((r) => r.executedAt >= f && r.executedAt <= t);
  }

  console.log(`EXECUTED resolved samples: ${rows.length}`);
  if (rows.length < 8) {
    console.error("Not enough samples to train (need ≥8). Add more CSV days.");
    process.exit(1);
  }

  const byMod: Record<string, { w: number; l: number }> = {};
  for (const r of rows) {
    byMod[r.module] ??= { w: 0, l: 0 };
    if (r.outcome === "SL_HIT") byMod[r.module].l += 1;
    else byMod[r.module].w += 1;
  }

  const model = trainLogisticSlModel(rows);
  saveModel(model);

  const report = {
    trainedAt: model.trainedAt,
    source: useLive ? "live-db" : dir,
    sampleN: model.sampleN,
    winN: model.winN,
    lossN: model.lossN,
    metrics: model.metrics,
    byModule: byMod,
    slCauses: model.slCauses,
    thresholds: model.thresholds,
    modelPath: MODEL_PATH,
  };
  saveReport(report);

  console.log(`
======== LEARN REPORT ========
Samples     : ${model.sampleN}  (${model.winN}W / ${model.lossN}L)
Holdout acc : ${(model.metrics.accuracy * 100).toFixed(1)}%
SL precision: ${(model.metrics.precisionSl * 100).toFixed(1)}%
SL recall   : ${(model.metrics.recallSl * 100).toFixed(1)}%
Baseline SL : ${(model.metrics.baselineSlRate * 100).toFixed(1)}%
Block P     : ${model.thresholds.blockP} (prefer ${model.thresholds.preferBlockP})
Model       : ${MODEL_PATH}
Report      : ${REPORT_PATH}
`);

  console.log("By module (W/L):");
  for (const [m, s] of Object.entries(byMod).sort()) {
    const n = s.w + s.l;
    const wr = n ? ((s.w / n) * 100).toFixed(0) : "—";
    console.log(`  ${m.padEnd(12)} ${s.w}W/${s.l}L  WR ${wr}%`);
  }

  console.log("\nTop SL causes:");
  for (const c of model.slCauses.slice(0, 6)) {
    console.log(
      `  [${c.pctOfLosses}%] ${c.label}  n=${c.n}  → ${c.fix}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
