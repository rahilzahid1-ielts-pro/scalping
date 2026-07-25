/**
 * Runtime gate — P(SL) from last trained model + cause tags + playbook.
 * Prefer modules use a higher block threshold (keep firing for results).
 */
import { extractFeatures, karachiHour } from "./features";
import { sessionOf } from "./marketContext";
import { loadModel } from "./modelStore";
import {
  lookupModuleMarket,
  lookupPlaybookAction,
} from "./scenarios";
import { predictSlProbability } from "./train";
import type { LearnGateResult, LearnModule, LearnRow, TrainedModel } from "./types";
import { matchCauseIds } from "./explain";

const PREFER = new Set<LearnModule>(["qs_pro", "cipher_b", "pro"]);

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
 * Blocks when:
 * - playbook/moduleMarket says avoid (non-prefer), or
 * - P(SL) high AND known loss-cause / hot hour
 * Prefer desks get higher P(SL) bar + playbook prefer leniency.
 */
export function gateLearnedLock(opts: {
  module: string;
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  at?: number;
  trend?: LearnRow["trend"];
  vol?: LearnRow["vol"];
}): LearnGateResult {
  const model = getLearnModel();
  if (!model) {
    return { ok: true, pSl: 0, reason: "no model", matchedCauses: [] };
  }

  const module = moduleFromRaw(opts.module);
  const at = opts.at ?? Date.now();
  const slMoney = Math.abs(opts.entry - opts.sl);
  const tp1Money = Math.abs(opts.tp1 - opts.entry);
  const session = sessionOf(at);

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
    session,
    trend: opts.trend,
    vol: opts.vol,
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
  // Pad/truncate vector if older model has different feature length
  let vec = feats.vector;
  if (model.featureNames.length !== vec.length) {
    const aligned = new Array(model.featureNames.length).fill(0);
    aligned[0] = 1;
    for (let i = 0; i < Math.min(vec.length, aligned.length); i++) {
      aligned[i] = vec[i] ?? 0;
    }
    vec = aligned;
  }
  const pSl = predictSlProbability(model, vec);
  const causes = matchCauseIds(stub, recent);

  const hour = karachiHour(at);
  const hourKey = `${module}|${hour}`;
  const hourStat = model.moduleHourSlRate[hourKey];
  if (hourStat && hourStat.n >= 3 && hourStat.rate >= 0.75) {
    causes.push(`hot_hour_${hour}`);
  }

  const playbook = model.playbook ?? [];
  const pb = lookupPlaybookAction(playbook, module, session, opts.side);
  const mm = lookupModuleMarket(model.moduleMarket ?? [], module, session);
  const isPrefer = PREFER.has(module);

  // Hard avoid from playbook / matrix — non-prefer only (keep prefer firing)
  if (!isPrefer && pb?.action === "avoid") {
    return {
      ok: false,
      pSl,
      reason: `playbook avoid ${pb.key} (SL ${pb.rate}% n=${pb.n})`,
      matchedCauses: [...causes, "playbook_avoid"],
    };
  }
  if (!isPrefer && mm?.verdict === "avoid") {
    return {
      ok: false,
      pSl,
      reason: `module×market avoid ${mm.key} (WR ${mm.wr}% n=${mm.n})`,
      matchedCauses: [...causes, "market_avoid"],
    };
  }

  let thr = isPrefer
    ? model.thresholds.preferBlockP
    : model.thresholds.blockP;
  // Prefer playbook cell → small leniency so winners still print
  if (pb?.action === "prefer" || mm?.verdict === "strong") {
    thr = Math.min(0.85, thr + 0.06);
  }
  // Weak cell → slightly tighter for non-prefer
  if (!isPrefer && (pb?.action === "throttle" || mm?.verdict === "weak")) {
    thr = Math.max(0.45, thr - 0.05);
  }

  const dangerous =
    pSl >= thr &&
    (causes.length > 0 ||
      (hourStat != null && hourStat.n >= 4 && hourStat.rate >= 0.7) ||
      pb?.action === "throttle" ||
      mm?.verdict === "weak");

  if (dangerous) {
    return {
      ok: false,
      pSl,
      reason: `learn P(SL)=${(pSl * 100).toFixed(0)}% ≥ ${(thr * 100).toFixed(0)}% · ${causes.slice(0, 3).join(",") || pb?.action || mm?.verdict || "hot_hour"}`,
      matchedCauses: causes,
    };
  }

  return {
    ok: true,
    pSl,
    reason: `learn P(SL)=${(pSl * 100).toFixed(0)}%${pb ? ` · ${pb.action}` : ""}`,
    matchedCauses: causes,
  };
}
