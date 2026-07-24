/**
 * Parse Trade History CSV exports (UI download format).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LearnModule, LearnRow } from "./types";

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
      continue;
    }
    if (c === "," && !inQ) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

const MODULE_MAP: Record<string, LearnModule> = {
  scalp: "scalp",
  intraday: "intraday",
  "quick scalp": "quick_scalp",
  quick_scalp: "quick_scalp",
  "qs pro": "qs_pro",
  qs_pro: "qs_pro",
  pro: "pro",
  intra30: "intra30",
  "cipher b": "cipher_b",
  cipher_b: "cipher_b",
  "ttrades fractal": "fractal",
  fractal: "fractal",
};

export function normalizeLearnModule(raw: string): LearnModule {
  const k = String(raw || "")
    .trim()
    .toLowerCase();
  return MODULE_MAP[k] ?? "unknown";
}

/** Parse "24 Jul 2026, 08:47 pm" Asia/Karachi wall → ms (approx +5). */
export function parseKarachiDisplay(s: string): number | null {
  const t = String(s || "").trim();
  if (!t) return null;
  // 25 Jul 2026, 01:57 am
  const m =
    /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(
      t,
    );
  if (!m) return null;
  const months: Record<string, number> = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };
  const mon = months[m[2].toLowerCase()];
  if (mon == null) return null;
  let hour = Number(m[4]);
  const min = Number(m[5]);
  const ap = m[6].toLowerCase();
  if (ap === "pm" && hour < 12) hour += 12;
  if (ap === "am" && hour === 12) hour = 0;
  const day = Number(m[1]);
  const year = Number(m[3]);
  // Treat as Asia/Karachi (= UTC+5) → UTC ms
  return Date.UTC(year, mon, day, hour - 5, min, 0);
}

function num(s: string | undefined): number {
  const n = Number(String(s ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

export function rowsFromHistoryCsv(
  filePath: string,
  sourceLabel?: string,
): LearnRow[] {
  const text = readFileSync(filePath, "utf8");
  const raw = parseCsv(text);
  const source = sourceLabel || filePath;
  const out: LearnRow[] = [];

  for (const r of raw) {
    const status = (r["Execution status"] || "").toUpperCase();
    if (status !== "EXECUTED") continue;
    const result = (r["Result"] || "").toUpperCase();
    let outcome: LearnRow["outcome"] | null = null;
    if (result.includes("SL")) outcome = "SL_HIT";
    else if (result.includes("TP2")) outcome = "TP2_HIT";
    else if (result.includes("TP1") || result.includes("TP "))
      outcome = "TP1_HIT";
    else continue; // OPEN / INVALIDATED

    const moduleLabel = r["Module"] || "?";
    const module = normalizeLearnModule(moduleLabel);
    const sideRaw = (r["Side"] || "").toUpperCase();
    if (sideRaw !== "BUY" && sideRaw !== "SELL") continue;

    const entry = num(r["Entry"]);
    const sl = num(r["SL"]);
    const tp1 = num(r["TP1"]);
    if (![entry, sl, tp1].every(Number.isFinite)) continue;

    const executedAt =
      parseKarachiDisplay(r["Executed at (PKT)"] || r["Start (PKT)"] || "") ??
      Date.now();
    const resolvedAt = parseKarachiDisplay(r["Resolved at (PKT)"] || "");

    const slMoney =
      Math.abs(num(r["SL $"])) || Math.abs(entry - sl);
    const tp1Money = Math.abs(num(r["TP1 $"])) || Math.abs(tp1 - entry);
    const pnlMoney = Number.isFinite(num(r["P&L $"])) ? num(r["P&L $"]) : null;
    const realizedR = Number.isFinite(num(r["R"])) ? num(r["R"]) : null;

    out.push({
      id: `${module}-${sideRaw}-${entry}-${executedAt}`,
      module,
      moduleLabel,
      side: sideRaw,
      entry,
      sl,
      tp1,
      slMoney,
      tp1Money,
      executedAt,
      resolvedAt,
      outcome,
      realizedR,
      pnlMoney,
      source,
    });
  }
  return out;
}

export function loadLearnRowsFromDir(dir: string): LearnRow[] {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("trade-history") && f.endsWith(".csv"))
    .map((f) => join(dir, f))
    .filter((p) => statSync(p).isFile())
    .sort();

  const seen = new Set<string>();
  const all: LearnRow[] = [];
  for (const f of files) {
    for (const row of rowsFromHistoryCsv(f)) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      all.push(row);
    }
  }
  all.sort((a, b) => a.executedAt - b.executedAt);
  return all;
}
