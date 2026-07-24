/**
 * Runtime gate — P(SL) from last trained model + cause tags.
 * Prefer modules use a higher block threshold (keep firing for results).
 */
import { extractFeatures, karachiHour } from "./features";
import { loadModel } from "./modelStore";
import { predictSlProbability } from "./train";
import type { LearnGateResult, LearnModule, LearnRow, TrainedModel } from "./types";
import { matchCauseIds } from "./explain";

const PREFER = new Set<LearnModule>(["qs_pro", "cipher_b"]);

let cached: TrainedModel | null | undefined;
/** Rolling recent resolved for stack/post-TP flags (in-process). */
const recent: LearnRow[] = [];

export function resetLearnRuntimeCache(): void {
  cached = undefined;
  recent.length = 0;
}

export function getLearnModel(): TrainedModel | null {
  if (cached === undefined) cached = loadModel();
  return cached ?? null;
}

export function noteLearnResolved(row: LearnRow): void {
  recent.push(row);
  while (recent.length > 80) recent.shift();
}

function moduleFromRaw(raw: string): LearnModule {
  const m = String(raw || "")
    .toLowerCase()
    .trim();
  if (m === "scalping") return "scalp";
  if (m === "pulse") return "qs_pro";
  if (m === "cipher_b_clone") return "cipher_b";
  const ok: LearnModule[] = [
    "scalp",
    "intraday",
    "quick_scalp",
    "qs_pro",
    "pro",
    "intra30",
    "cipher_b",
    "fractal",
  ];
  return (ok as string[]).includes(m) ? (m as LearnModule) : "unknown";
}

/**
 * Soft learned gate. If no model → allow (ok).
 * Blocks only when P(SL) high AND at least one known loss-cause matches
 * (avoids over-silence on small samples).
 */
export function gateLearnedLock(opts: {
  module: string;
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  at?: number;
}): LearnGateResult {
  const model = getLearnModel();
  if (!model) {
    return { ok: true, pSl: 0, reason: "no model", matchedCauses: [] };
  }

  const module = moduleFromRaw(opts.module);
  const at = opts.at ?? Date.now();
  const slMoney = Math.abs(opts.entry - opts.sl);
  const tp1Money = Math.abs(opts.tp1 - opts.entry);

  const stub: LearnRow = {
    id: `live-${at}`,
    module,
    moduleLabel: module,
    side: opts.side,
    entry: opts.entry,
    sl: opts.sl,
    tp1: opts.tp1,
    slMoney,
    tp1Money,
    executedAt: at,
    resolvedAt: null,
    outcome: "TP1_HIT",
    realizedR: null,
    pnlMoney: null,
    source: "live",
  };

  const WINDOW = 90 * 60 * 1000;
  let stack = false;
  let afterTp = false;
  for (let i = recent.length - 1; i >= 0; i--) {
    const p = recent[i];
    if (at - p.executedAt > WINDOW) break;
    if (p.side !== opts.side) continue;
    if (p.module !== module && Math.abs(p.entry - opts.entry) <= 8) stack = true;
    if (p.outcome === "TP1_HIT" || p.outcome === "TP2_HIT") afterTp = true;
  }

  const feats = extractFeatures(stub, {
    stackSameSide90m: stack,
    afterTpSameSide90m: afterTp,
  });
  const pSl = predictSlProbability(model, feats.vector);
  const causes = matchCauseIds(stub, recent);

  const hour = karachiHour(at);
  const hourKey = `${module}|${hour}`;
  const hourStat = model.moduleHourSlRate[hourKey];
  if (hourStat && hourStat.n >= 3 && hourStat.rate >= 0.75) {
    causes.push(`hot_hour_${hour}`);
  }

  const thr = PREFER.has(module)
    ? model.thresholds.preferBlockP
    : model.thresholds.blockP;

  // Don't silence on model alone with tiny cause overlap — need model + cause
  const dangerous =
    pSl >= thr &&
    (causes.length > 0 ||
      (hourStat != null && hourStat.n >= 4 && hourStat.rate >= 0.7));

  if (dangerous) {
    return {
      ok: false,
      pSl,
      reason: `learn P(SL)=${(pSl * 100).toFixed(0)}% ≥ ${(thr * 100).toFixed(0)}% · ${causes.slice(0, 3).join(",") || "hot_hour"}`,
      matchedCauses: causes,
    };
  }

  return {
    ok: true,
    pSl,
    reason: `learn P(SL)=${(pSl * 100).toFixed(0)}%`,
    matchedCauses: causes,
  };
}
