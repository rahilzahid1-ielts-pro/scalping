/**
 * Scenario playbook, TP-win mining, module × market matrix.
 */
import { karachiHour } from "./features";
import { sessionOf } from "./marketContext";
import type {
  LearnRow,
  ModuleMarketCell,
  ModuleMarketVerdict,
  ScenarioBucket,
  TpWinStat,
} from "./types";

type WinDef = {
  id: string;
  label: string;
  tip: string;
  match: (row: LearnRow, all: LearnRow[], idx: number) => boolean;
};

const WIN_PATTERNS: WinDef[] = [
  {
    id: "trend_aligned",
    label: "Trend-aligned side (BUY in up / SELL in down)",
    tip: "Prefer modules when side matches M5 trend",
    match: (r) =>
      (r.side === "BUY" && r.trend === "up") ||
      (r.side === "SELL" && r.trend === "down"),
  },
  {
    id: "clean_rr",
    label: "Clean RR (TP1 ≥ 0.85 × SL $)",
    tip: "Favor setups with reward ≈ risk or better",
    match: (r) => r.slMoney > 0 && r.tp1Money / r.slMoney >= 0.85,
  },
  {
    id: "mid_sl",
    label: "Mid SL band ($6–$12)",
    tip: "Prefer $6–$12 risk desks over fat/tight extremes",
    match: (r) => r.slMoney >= 6 && r.slMoney <= 12,
  },
  {
    id: "low_vol",
    label: "Low volatility regime",
    tip: "Size up slightly in low-ATR windows for lean desks",
    match: (r) => r.vol === "low",
  },
  {
    id: "no_stack",
    label: "No same-print lean stack in prior 90m",
    tip: "Keep lean-family cooldown — solo prints win more",
    match: (row, all, idx) => {
      const w = 90 * 60 * 1000;
      for (let j = idx - 1; j >= 0; j--) {
        const p = all[j];
        if (row.executedAt - p.executedAt > w) break;
        if (p.module === row.module) continue;
        if (p.side !== row.side) continue;
        if (Math.abs(p.entry - row.entry) <= 8) return false;
      }
      return true;
    },
  },
  {
    id: "asia_qs_family",
    label: "Asia AM + QS Pro / Quick Scalp / Fractal",
    tip: "Lean scalping family strong in Asia morning",
    match: (r) => {
      const s = r.session ?? sessionOf(r.executedAt);
      return (
        s === "asia_am" &&
        (r.module === "qs_pro" ||
          r.module === "quick_scalp" ||
          r.module === "fractal")
      );
    },
  },
  {
    id: "mid_pro_cipher",
    label: "Mid session + Pro / Cipher B",
    tip: "Prefer Pro / Cipher into London–NY mid",
    match: (r) => {
      const s = r.session ?? sessionOf(r.executedAt);
      return (
        s === "mid" && (r.module === "pro" || r.module === "cipher_b")
      );
    },
  },
];

function exampleLine(r: LearnRow): string {
  const when = new Date(r.executedAt + 5 * 3600_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 16);
  return `${r.moduleLabel} ${r.side} @ ${r.entry} (${when} PKT~)`;
}

export function mineTpWins(rows: LearnRow[]): TpWinStat[] {
  const wins = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.outcome !== "SL_HIT");
  const total = wins.length || 1;

  return WIN_PATTERNS.map((c) => {
    const hits = wins.filter(({ r, i }) => c.match(r, rows, i));
    return {
      id: c.id,
      label: c.label,
      n: hits.length,
      pctOfWins: Math.round((hits.length / total) * 1000) / 10,
      examples: hits.slice(0, 3).map(({ r }) => exampleLine(r)),
      tip: c.tip,
    };
  }).sort((a, b) => b.n - a.n);
}

function verdictOf(n: number, wr: number, slRate: number): ModuleMarketVerdict {
  if (n >= 25 && (wr < 45 || slRate >= 0.4)) return "avoid";
  if (n >= 25 && wr < 55) return "weak";
  if (n >= 40 && wr >= 72) return "strong";
  if (n >= 25 && wr >= 62) return "ok";
  // Small samples: don't over-label — treat as ok for reporting
  return "ok";
}

type Acc = { n: number; w: number; l: number };

function toCell(
  key: string,
  a: Acc,
  parts: {
    module: string;
    session?: string;
    trend?: string;
    vol?: string;
    side?: string;
  },
): ModuleMarketCell | null {
  if (a.n < 15) return null;
  const wr = Math.round((a.w / a.n) * 1000) / 10;
  const slRate = a.l / a.n;
  return {
    key,
    ...parts,
    n: a.n,
    w: a.w,
    l: a.l,
    wr,
    verdict: verdictOf(a.n, wr, slRate),
  };
}

/** Module × session / trend / vol / side performance matrix. */
export function moduleMarketMatrix(rows: LearnRow[]): ModuleMarketCell[] {
  const buckets = new Map<string, Acc & { meta: Parameters<typeof toCell>[2] }>();

  const bump = (
    key: string,
    meta: Parameters<typeof toCell>[2],
    isSl: boolean,
  ) => {
    let a = buckets.get(key);
    if (!a) {
      a = { n: 0, w: 0, l: 0, meta };
      buckets.set(key, a);
    }
    a.n += 1;
    if (isSl) a.l += 1;
    else a.w += 1;
  };

  for (const r of rows) {
    const isSl = r.outcome === "SL_HIT";
    const session = r.session ?? sessionOf(r.executedAt);
    const trend = r.trend ?? "flat";
    const vol = r.vol ?? "mid";
    bump(`module_session:${r.module}|${session}`, {
      module: r.module,
      session,
    }, isSl);
    bump(`module_trend:${r.module}|${trend}`, {
      module: r.module,
      trend,
    }, isSl);
    bump(`module_vol:${r.module}|${vol}`, {
      module: r.module,
      vol,
    }, isSl);
    bump(`module_side:${r.module}|${r.side}`, {
      module: r.module,
      side: r.side,
    }, isSl);
    bump(`module_session_trend:${r.module}|${session}|${trend}`, {
      module: r.module,
      session,
      trend,
    }, isSl);
  }

  const out: ModuleMarketCell[] = [];
  for (const [key, a] of buckets) {
    const cell = toCell(key, a, a.meta);
    if (cell) out.push(cell);
  }
  return out.sort((a, b) => {
    const order = { avoid: 0, weak: 1, ok: 2, strong: 3 };
    if (a.verdict !== b.verdict) return order[a.verdict] - order[b.verdict];
    return a.wr - b.wr || b.n - a.n;
  });
}

function tipFor(key: string): string {
  if (key.startsWith("module:scalp") || key === "fat_sl")
    return "Skip / demote — fat risk";
  if (key === "bad_rr") return "Skip reward << risk";
  if (
    key.includes("night") &&
    key.includes("BUY") &&
    (key.includes("intraday") || key.includes(":scalp") || key.includes("intra30"))
  )
    return "Block late counter BUY on weak desks";
  if (key.startsWith("session:asia_am") && key.includes("SELL"))
    return "Careful — bounce cluster risk after dump";
  if (key.startsWith("module:intra30") || key.startsWith("module:intraday"))
    return "Size smaller / day-boost only when green";
  if (
    key.includes("|night|BUY") ||
    (key.includes("|night") && key.includes("fractal"))
  )
    return "Strong night BUY pocket — keep prefer firing";
  if (
    key.startsWith("module:cipher_b") ||
    key.startsWith("module:qs_pro") ||
    key.startsWith("module:pro") ||
    key.startsWith("module:fractal") ||
    key.startsWith("module:quick_scalp")
  )
    return "Prefer when not stacked / post-TP";
  if (key.includes("|up") || key.includes("|down"))
    return "Respect M5 trend alignment";
  return "Use lean cooldown + post-TP pause";
}

/** Avoid (high SL) + prefer (high WR) scenario buckets. */
export function buildScenarioPlaybook(rows: LearnRow[]): ScenarioBucket[] {
  type Acc2 = { n: number; sl: number };
  const buckets = new Map<string, Acc2>();

  const bump = (key: string, isSl: boolean) => {
    const a = buckets.get(key) ?? { n: 0, sl: 0 };
    a.n += 1;
    if (isSl) a.sl += 1;
    buckets.set(key, a);
  };

  for (const r of rows) {
    const isSl = r.outcome === "SL_HIT";
    const session = r.session ?? sessionOf(r.executedAt);
    const trend = r.trend ?? "flat";
    const vol = r.vol ?? "mid";
    bump(`module:${r.module}`, isSl);
    bump(`side:${r.side}`, isSl);
    bump(`session:${session}`, isSl);
    bump(`trend:${trend}`, isSl);
    bump(`vol:${vol}`, isSl);
    bump(`module_session:${r.module}|${session}`, isSl);
    bump(`module_side:${r.module}|${r.side}`, isSl);
    bump(`module_trend:${r.module}|${trend}`, isSl);
    bump(`module_session_side:${r.module}|${session}|${r.side}`, isSl);
    if (r.slMoney > 12) bump("fat_sl", isSl);
    if (r.slMoney > 0 && r.tp1Money / r.slMoney < 0.7) bump("bad_rr", isSl);
  }

  const out: ScenarioBucket[] = [];
  for (const [key, a] of buckets) {
    if (a.n < 25) continue;
    const rate = a.sl / a.n;
    const wr = 1 - rate;
    let action: ScenarioBucket["action"];
    if (rate >= 0.4) action = "avoid";
    else if (rate >= 0.3) action = "throttle";
    else if (wr >= 0.72 && a.n >= 40) action = "prefer";
    else action = "allow";
    out.push({
      key,
      n: a.n,
      sl: a.sl,
      wr: Math.round(wr * 1000) / 10,
      rate: Math.round(rate * 1000) / 10,
      action,
      tip: tipFor(key),
    });
  }
  return out.sort((a, b) => {
    const rank = { avoid: 0, throttle: 1, allow: 2, prefer: 3 };
    if (a.action !== b.action) return rank[a.action] - rank[b.action];
    if (a.action === "prefer") return b.wr - a.wr || b.n - a.n;
    return b.rate - a.rate || b.n - a.n;
  });
}

/** Lookup helper for runtime — exact then module|session. */
export function lookupPlaybookAction(
  playbook: ScenarioBucket[],
  module: string,
  session: string,
  side: string,
): ScenarioBucket | null {
  const keys = [
    `module_session_side:${module}|${session}|${side}`,
    `module_session:${module}|${session}`,
    `module_side:${module}|${side}`,
    `module:${module}`,
  ];
  for (const k of keys) {
    const hit = playbook.find((p) => p.key === k);
    if (hit) return hit;
  }
  return null;
}

export function lookupModuleMarket(
  cells: ModuleMarketCell[],
  module: string,
  session: string,
): ModuleMarketCell | null {
  return (
    cells.find((c) => c.key === `module_session:${module}|${session}`) ?? null
  );
}

/** Kept for callers that only need hour — re-export convenience. */
export { karachiHour };
