/**
 * Quick check: Cipher B + Fractal only — verify bar-time labels survive year filter.
 *
 *   npm run learn:check-cf -- --file=data/XAU_5m_data.csv --from=2023 --to=2025
 *   npm run learn:check-cf -- --from=2024 --to=2024
 */
import { existsSync } from "node:fs";
import { loadHistoricalFile } from "../src/backtest/loadData";
import type { Candle } from "../src/types";
import { runCompareStrategyBacktest } from "../src/strategyCompare/backtest";
import {
  getBacktestStrategyDb,
  listStrategyRows,
} from "../src/strategyCompare/store";
import { attachMarketContext } from "../src/learn/marketContext";
import type { LearnModule, LearnRow } from "../src/learn/types";

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
  return new Date(ms).getUTCFullYear() === year;
}

function collectCompare(strategy: "cipher_b_clone" | "fractal"): LearnRow[] {
  const module: LearnModule =
    strategy === "cipher_b_clone" ? "cipher_b" : "fractal";
  const label = strategy === "cipher_b_clone" ? "Cipher B" : "Fractal";
  const db = getBacktestStrategyDb(false);
  const out: LearnRow[] = [];
  for (const r of listStrategyRows(db, strategy)) {
    if (r.outcome !== "TP1_HIT" && r.outcome !== "SL_HIT") continue;
    const executedAt = r.executedAt ?? r.time;
    const slMoney = Math.abs(r.entry - r.sl);
    const tp1Money = Math.abs(r.tp1 - r.entry);
    out.push({
      id: r.id,
      module,
      moduleLabel: label,
      side: r.direction,
      entry: r.entry,
      sl: r.sl,
      tp1: r.tp1,
      slMoney,
      tp1Money,
      executedAt,
      resolvedAt: r.resolvedAt,
      outcome: r.outcome,
      realizedR: r.realizedR,
      pnlMoney:
        r.realizedR != null
          ? Math.round(slMoney * r.realizedR * 100) / 100
          : null,
      source: "backtest-m5",
    });
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const file = argValue(argv, "--file") ?? DEFAULT_FILE;
  const fromY = Number(argValue(argv, "--from") ?? 2024);
  const toY = Number(argValue(argv, "--to") ?? fromY);
  const spread = Number(argValue(argv, "--spread") ?? 0.25);

  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  console.log(`Loading ${file}…`);
  const loaded = loadHistoricalFile(file);
  console.log(
    `Cipher+Fractal check ${fromY}→${toY} · spread=${spread}\n`,
  );

  const totals: Record<string, { w: number; l: number; kept: number; raw: number }> = {
    cipher_b: { w: 0, l: 0, kept: 0, raw: 0 },
    fractal: { w: 0, l: 0, kept: 0, raw: 0 },
  };

  for (let y = fromY; y <= toY; y++) {
    const { candles, days } = sliceYear(loaded.candles, y);
    if (candles.length < 5000) {
      console.log(`==== ${y} SKIP (${candles.length} bars) ====`);
      continue;
    }
    console.log(`==== YEAR ${y} · ${candles.length} bars · days≈${days} ====`);

    for (const strategy of ["cipher_b_clone", "fractal"] as const) {
      const mod = strategy === "cipher_b_clone" ? "cipher_b" : "fractal";
      const t0 = Date.now();
      const stats = runCompareStrategyBacktest({
        candles,
        strategy,
        days,
        spread,
      });
      const rows = collectCompare(strategy);
      attachMarketContext(rows, candles);
      const kept = rows.filter((r) => inYear(r.executedAt, y));
      const dropped = rows.length - kept.length;
      const w = kept.filter((r) => r.outcome !== "SL_HIT").length;
      const l = kept.filter((r) => r.outcome === "SL_HIT").length;
      const wr = kept.length ? ((100 * w) / kept.length).toFixed(1) : "n/a";

      totals[mod].raw += rows.length;
      totals[mod].kept += kept.length;
      totals[mod].w += w;
      totals[mod].l += l;

      const sample = kept[0];
      const sampleYear = sample
        ? new Date(sample.executedAt).getUTCFullYear()
        : null;

      console.log(
        `  ${mod}: raw=${rows.length} kept=${kept.length} dropped=${dropped} · ${w}W/${l}L WR ${wr}% · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      console.log(
        `         stats ${stats.wins}W/${stats.losses}L · sample executedAt year=${sampleYear} session=${sample?.session ?? "-"} trend=${sample?.trend ?? "-"}`,
      );
      if (dropped > 0) {
        const bad = rows.find((r) => !inYear(r.executedAt, y));
        console.log(
          `         FAIL sample dropped year=${bad ? new Date(bad.executedAt).getUTCFullYear() : "?"} (want ${y})`,
        );
      }
    }
  }

  console.log("\n======== CIPHER + FRACTAL CHECK ========");
  for (const mod of ["cipher_b", "fractal"] as const) {
    const t = totals[mod];
    const wr = t.kept ? ((100 * t.w) / t.kept).toFixed(1) : "n/a";
    const ok = t.kept > 0 && t.kept === t.raw;
    console.log(
      `${mod}: kept ${t.kept}/${t.raw} · ${t.w}W/${t.l}L WR ${wr}% · ${ok ? "OK year-filter" : t.kept === 0 ? "FAIL none kept" : "WARN some dropped"}`,
    );
  }
}

main();
