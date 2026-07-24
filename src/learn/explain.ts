/**
 * Rule-mine SL causes from labeled EXECUTED rows (human-readable).
 */
import { karachiHour } from "./features";
import type { LearnRow, SlCauseStat } from "./types";

type CauseDef = {
  id: string;
  label: string;
  fix: string;
  match: (row: LearnRow, all: LearnRow[], idx: number) => boolean;
};

const CAUSES: CauseDef[] = [
  {
    id: "fat_sl",
    label: "Fat SL (>$12 risk)",
    fix: "Demote / skip Quick Scalp & wide Scalp; prefer $5–$9 risk desks",
    match: (r) => r.slMoney > 12,
  },
  {
    id: "same_print_stack",
    label: "Same-print lean stack (≤$8, 90m, other module)",
    fix: "Lean-family correlation cooldown",
    match: (row, all, idx) => {
      const w = 90 * 60 * 1000;
      for (let j = idx - 1; j >= 0; j--) {
        const p = all[j];
        if (row.executedAt - p.executedAt > w) break;
        if (p.module === row.module) continue;
        if (p.side !== row.side) continue;
        if (Math.abs(p.entry - row.entry) <= 8) return true;
      }
      return false;
    },
  },
  {
    id: "post_tp_same_side",
    label: "Re-fire same side within 90m after a TP",
    fix: "Post-TP bounce pause",
    match: (row, all, idx) => {
      const w = 90 * 60 * 1000;
      for (let j = idx - 1; j >= 0; j--) {
        const p = all[j];
        if (row.executedAt - p.executedAt > w) break;
        if (p.side !== row.side) continue;
        if (p.outcome === "TP1_HIT" || p.outcome === "TP2_HIT") return true;
      }
      return false;
    },
  },
  {
    id: "asia_bounce_sell",
    label: "Asia mid-morning SELL (08–12 PKT)",
    fix: "After morning dump, pause stacked SELLs into bounce",
    match: (r) => {
      const h = karachiHour(r.executedAt);
      return r.side === "SELL" && h >= 8 && h < 12;
    },
  },
  {
    id: "night_counter_buy",
    label: "Late / night BUY (20–02 PKT)",
    fix: "Sell-lean day → block counter BUY (esp. Scalp)",
    match: (r) => {
      const h = karachiHour(r.executedAt);
      return r.side === "BUY" && (h >= 20 || h < 2);
    },
  },
  {
    id: "whipsaw_fast",
    label: "Whipsaw — resolved ≤5 minutes",
    fix: "Opposite-block / min hold / skip noise re-entries",
    match: (r) => {
      if (r.resolvedAt == null) return false;
      return r.resolvedAt - r.executedAt <= 5 * 60 * 1000;
    },
  },
  {
    id: "scalp_module",
    label: "Scalp module fill",
    fix: "Keep Scalp demoted from size / demo",
    match: (r) => r.module === "scalp",
  },
  {
    id: "asymmetric_rr",
    label: "Bad RR (TP1 < 0.7 × SL $)",
    fix: "Skip setups where reward << risk",
    match: (r) => r.slMoney > 0 && r.tp1Money / r.slMoney < 0.7,
  },
];

export function mineSlCauses(rows: LearnRow[]): SlCauseStat[] {
  const losses = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.outcome === "SL_HIT");
  const total = losses.length || 1;

  return CAUSES.map((c) => {
    const hits = losses.filter(({ r, i }) => c.match(r, rows, i));
    const examples = hits.slice(0, 3).map(({ r }) => {
      const when = new Date(r.executedAt + 5 * 3600_000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 16);
      return `${r.moduleLabel} ${r.side} @ ${r.entry} (${when} PKT~)`;
    });
    return {
      id: c.id,
      label: c.label,
      n: hits.length,
      pctOfLosses: Math.round((hits.length / total) * 1000) / 10,
      examples,
      fix: c.fix,
    };
  }).sort((a, b) => b.n - a.n);
}

export function matchCauseIds(
  row: LearnRow,
  allRecent: LearnRow[],
): string[] {
  const idx = allRecent.length;
  const all = [...allRecent, row];
  return CAUSES.filter((c) => c.match(row, all, idx)).map((c) => c.id);
}
