/**
 * Day-adaptive module regime — soft “jo aaj jeet raha usko zyada”.
 *
 * Positive-day desk (not silent desk):
 * - Prefer (QS Pro + Cipher) keep firing — 2 SL = throttle, 3 SL = pause
 * - Shorter post-TP pause on prefer (45m) so winners still print
 * - Demote Scalp / Quick Scalp (fat SL killers)
 * - Demo size scales by tier; day stop / profit-protect in positiveDayDesk
 */
import {
  buildHistoryPayload,
  karachiYmd,
  type HistoryModuleId,
  type HistoryTrade,
} from "../history/apiHistory";
import { gateLearnedLock } from "../learn/runtime";

export type RegimeModule = HistoryModuleId;

export type RegimeTier =
  | "prefer"
  | "normal"
  | "throttle"
  | "pause"
  | "demote";

export interface ModuleDayScore {
  module: RegimeModule;
  executed: number;
  wins: number;
  losses: number;
  netR: number;
  lastTpAt: number | null;
  lastSlAt: number | null;
  lastSide: "BUY" | "SELL" | null;
  sellWins: number;
  buyWins: number;
}

export interface ModuleRegime {
  module: RegimeModule;
  tier: RegimeTier;
  score: ModuleDayScore;
  reasons: string[];
  allowDemoFollow: boolean;
  allowNewLock: boolean;
  /** Extra cooldown floor when throttled (ms). */
  cooldownMs: number;
  /** Demo risk multiplier (1 = full riskPct). */
  riskMult: number;
}

export interface DayRegimeSnapshot {
  date: string;
  refreshedAt: number;
  byModule: Record<RegimeModule, ModuleRegime>;
  sellLeanDay: boolean;
  leanLastTp: { at: number; side: "BUY" | "SELL" } | null;
}

export interface LockGateResult {
  ok: boolean;
  reason: string;
  tier: RegimeTier;
  cooldownMs: number;
}

const ALL_MODULES: RegimeModule[] = [
  "scalp",
  "intraday",
  "quick_scalp",
  "qs_pro",
  "pro",
  "intra30",
  "cipher_b",
  "fractal",
];

/** Daily drivers — keep trading (results > silence).
 *  365d no-Scalp backtest rank: Fractal/QS/Cipher/Pro strong; Intra30/Intraday weak.
 *  Fractal stays out of prefer (same-print with QS Pro). QS stays demoted (fat SL). */
const PREFER_BASE = new Set<RegimeModule>(["qs_pro", "cipher_b", "pro"]);

/** Noise / fat SL desks — demoted unless env override. */
const DEMOTE_BASE = new Set<RegimeModule>(["scalp", "quick_scalp"]);

/** Correlated lean / same-print family. */
export const LEAN_FAMILY = new Set<RegimeModule>([
  "qs_pro",
  "cipher_b",
  "quick_scalp",
  "fractal",
]);

/**
 * Demo follow candidates — Fractal dropped (same-print double with QS Pro).
 * Prefer + Intraday + Intra30 when tier allows.
 */
const DEMO_CANDIDATES = new Set<RegimeModule>([
  "intraday",
  "intra30",
  "cipher_b",
  "qs_pro",
  "quick_scalp",
  "pro",
]);

const MIN_SAMPLE = 2;
const TWO_SL_SOFT = 2;
const THREE_SL_HARD = 3;
const POST_TP_PAUSE_MS = 90 * 60 * 1000;
const POST_TP_PREFER_MS = 45 * 60 * 1000;
const THROTTLE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const CACHE_TTL_MS = 90_000;

let cache: DayRegimeSnapshot | null = null;
let cacheInflight: Promise<DayRegimeSnapshot> | null = null;

/** In-process TP stamps (faster than waiting for history refresh). */
const liveTpStamps: { module: RegimeModule; side: "BUY" | "SELL"; at: number }[] =
  [];

function isWin(outcome: string): boolean {
  return outcome === "TP1_HIT" || outcome === "TP2_HIT";
}

function isLoss(outcome: string): boolean {
  return outcome === "SL_HIT";
}

function emptyScore(module: RegimeModule): ModuleDayScore {
  return {
    module,
    executed: 0,
    wins: 0,
    losses: 0,
    netR: 0,
    lastTpAt: null,
    lastSlAt: null,
    lastSide: null,
    sellWins: 0,
    buyWins: 0,
  };
}

function riskMultForTier(
  tier: RegimeTier,
  module: RegimeModule,
  score: ModuleDayScore,
): number {
  if (tier === "demote" || tier === "pause") return 0;
  if (tier === "throttle") return 0.5;
  if (tier === "prefer") {
    if (score.wins >= 2 && score.netR > 0) return 1.25;
    return 1;
  }
  if (module === "intra30" || module === "intraday") return 0.85;
  return 0.75;
}

/** Pure: score EXECUTED + resolved TP/SL only (locks / misses ignored). */
export function scoreModulesFromTrades(
  trades: HistoryTrade[],
): Record<RegimeModule, ModuleDayScore> {
  const out = Object.fromEntries(
    ALL_MODULES.map((m) => [m, emptyScore(m)]),
  ) as Record<RegimeModule, ModuleDayScore>;

  for (const t of trades) {
    if (!t.executed) continue;
    if (!isWin(t.outcome) && !isLoss(t.outcome)) continue;
    const s = out[t.module];
    if (!s) continue;
    s.executed += 1;
    s.lastSide = t.side;
    const r =
      t.realizedR != null && Number.isFinite(t.realizedR)
        ? t.realizedR
        : isWin(t.outcome)
          ? 1
          : -1;
    s.netR += r;
    const at = t.resolvedAt ?? t.executedAt ?? t.at;
    if (isWin(t.outcome)) {
      s.wins += 1;
      if (t.side === "SELL") s.sellWins += 1;
      else s.buyWins += 1;
      if (s.lastTpAt == null || at > s.lastTpAt) s.lastTpAt = at;
    } else {
      s.losses += 1;
      if (s.lastSlAt == null || at > s.lastSlAt) s.lastSlAt = at;
    }
  }

  for (const m of ALL_MODULES) {
    out[m].netR = Math.round(out[m].netR * 1000) / 1000;
  }
  return out;
}

function allowScalpLocksEnv(): boolean {
  const v = (process.env.DAY_REGIME_ALLOW_SCALP ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

function allowQuickScalpLocksEnv(): boolean {
  const v = (process.env.DAY_REGIME_ALLOW_QUICK_SCALP ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/** Pure evaluator from today's scores (+ optional live TP stamps). */
export function evaluateDayRegimeFromScores(
  scores: Record<RegimeModule, ModuleDayScore>,
  now = Date.now(),
  liveTps: { module: RegimeModule; side: "BUY" | "SELL"; at: number }[] = [],
): Omit<DayRegimeSnapshot, "date" | "refreshedAt"> {
  const sellWins = ALL_MODULES.reduce((a, m) => a + scores[m].sellWins, 0);
  const buyWins = ALL_MODULES.reduce((a, m) => a + scores[m].buyWins, 0);
  const sellLeanDay = sellWins >= 2 && sellWins > buyWins;

  let leanLastTp: { at: number; side: "BUY" | "SELL" } | null = null;
  for (const m of LEAN_FAMILY) {
    const tp = scores[m].lastTpAt;
    if (tp == null) continue;
    const side = scores[m].lastSide;
    if (!side) continue;
    if (!leanLastTp || tp > leanLastTp.at) leanLastTp = { at: tp, side };
  }
  for (const stamp of liveTps) {
    if (!LEAN_FAMILY.has(stamp.module)) continue;
    if (now - stamp.at > POST_TP_PAUSE_MS) continue;
    if (!leanLastTp || stamp.at > leanLastTp.at) {
      leanLastTp = { at: stamp.at, side: stamp.side };
    }
  }

  const byModule = {} as Record<RegimeModule, ModuleRegime>;

  for (const module of ALL_MODULES) {
    const score = scores[module];
    const reasons: string[] = [];
    let tier: RegimeTier = "normal";
    let cooldownMs = 0;

    if (PREFER_BASE.has(module)) {
      tier = "prefer";
      reasons.push("preferred daily driver");
    }
    if (DEMOTE_BASE.has(module)) {
      tier = "demote";
      reasons.push("demoted base (noise / fat SL)");
    }
    if (module === "pro") {
      tier = "normal";
      reasons.push("measurement / rare");
    }

    if (score.executed === 0) {
      reasons.push("no executed fills yet — keep eligible");
    } else if (score.losses >= THREE_SL_HARD) {
      tier = "pause";
      reasons.push(`${score.losses} SL today → hard pause`);
    } else if (score.losses >= TWO_SL_SOFT) {
      if (PREFER_BASE.has(module)) {
        tier = "throttle";
        cooldownMs = THROTTLE_COOLDOWN_MS;
        reasons.push(`${score.losses} SL — prefer soft-throttle (still fires)`);
      } else {
        tier = "pause";
        reasons.push(`${score.losses} SL today → session pause`);
      }
    } else if (score.netR < 0 && score.executed >= MIN_SAMPLE) {
      tier = "throttle";
      cooldownMs = THROTTLE_COOLDOWN_MS;
      reasons.push(`net ${score.netR}R on ${score.executed} fills → throttle`);
    } else if (score.netR > 0 && score.wins >= MIN_SAMPLE) {
      if (module === "scalp") {
        tier = "demote";
        reasons.push("scalp stays demoted even if green");
      } else if (module === "quick_scalp") {
        tier = "normal";
        reasons.push("quick scalp proven green → escape demote");
      } else {
        tier = "prefer";
        reasons.push(`winning day ${score.wins}W net ${score.netR}R → boost`);
      }
    } else if (score.netR > 0 && score.wins >= 1 && !DEMOTE_BASE.has(module)) {
      if (tier !== "prefer") {
        tier = "normal";
        reasons.push("early green — keep normal");
      }
    }

    if (module === "scalp" && allowScalpLocksEnv() && tier === "demote") {
      tier = "throttle";
      cooldownMs = THROTTLE_COOLDOWN_MS;
      reasons.push("DAY_REGIME_ALLOW_SCALP override");
    }
    if (
      module === "quick_scalp" &&
      allowQuickScalpLocksEnv() &&
      tier === "demote"
    ) {
      tier = "throttle";
      cooldownMs = THROTTLE_COOLDOWN_MS;
      reasons.push("DAY_REGIME_ALLOW_QUICK_SCALP override");
    }

    let allowNewLock = tier !== "pause" && tier !== "demote";
    let allowDemoFollow =
      DEMO_CANDIDATES.has(module) &&
      allowNewLock &&
      (tier === "prefer" ||
        tier === "normal" ||
        (tier === "throttle" && PREFER_BASE.has(module)));

    if (module === "quick_scalp") {
      allowDemoFollow =
        allowDemoFollow && tier !== "demote" && tier !== "pause";
    }

    if (PREFER_BASE.has(module) && tier === "throttle") {
      allowNewLock = true;
      allowDemoFollow = DEMO_CANDIDATES.has(module);
    }
    if (PREFER_BASE.has(module) && (tier === "prefer" || tier === "normal")) {
      allowDemoFollow = true;
      allowNewLock = true;
    }

    const riskMult = riskMultForTier(tier, module, score);

    byModule[module] = {
      module,
      tier,
      score,
      reasons,
      allowDemoFollow: Boolean(allowDemoFollow),
      allowNewLock,
      cooldownMs:
        tier === "throttle"
          ? Math.max(cooldownMs, THROTTLE_COOLDOWN_MS)
          : cooldownMs,
      riskMult,
    };
  }

  return { byModule, sellLeanDay, leanLastTp };
}

export function evaluateDayRegime(
  trades: HistoryTrade[],
  now = Date.now(),
  date = karachiYmd(now),
): DayRegimeSnapshot {
  const scores = scoreModulesFromTrades(trades);
  const live = liveTpStamps.filter((s) => now - s.at <= POST_TP_PAUSE_MS);
  const body = evaluateDayRegimeFromScores(scores, now, live);
  return {
    date,
    refreshedAt: now,
    ...body,
  };
}

export async function refreshDayRegime(force = false): Promise<DayRegimeSnapshot> {
  const now = Date.now();
  if (
    !force &&
    cache &&
    now - cache.refreshedAt < CACHE_TTL_MS &&
    cache.date === karachiYmd(now)
  ) {
    return cache;
  }
  if (cacheInflight) return cacheInflight;

  cacheInflight = (async () => {
    const date = karachiYmd();
    const hist = await buildHistoryPayload({ date, module: "all" });
    const snap = evaluateDayRegime(hist.trades, Date.now(), date);
    cache = snap;
    cacheInflight = null;
    return snap;
  })().catch((e) => {
    cacheInflight = null;
    throw e;
  });

  return cacheInflight;
}

export function getCachedDayRegime(): DayRegimeSnapshot | null {
  return cache;
}

export function setDayRegimeCache(snap: DayRegimeSnapshot): void {
  cache = snap;
}

export function noteModuleTp(
  module: RegimeModule,
  side: "BUY" | "SELL",
  at = Date.now(),
): void {
  liveTpStamps.push({ module, side, at });
  while (liveTpStamps.length > 40) liveTpStamps.shift();
  if (cache && LEAN_FAMILY.has(module)) {
    if (!cache.leanLastTp || at >= cache.leanLastTp.at) {
      cache = {
        ...cache,
        refreshedAt: at,
        leanLastTp: { at, side },
      };
    }
  }
}

export function normalizeRegimeModule(raw: string): RegimeModule | null {
  const m = String(raw || "")
    .toLowerCase()
    .trim();
  if (m === "scalping") return "scalp";
  if (m === "pulse") return "qs_pro";
  if (m === "cipher_b_clone") return "cipher_b";
  if ((ALL_MODULES as string[]).includes(m)) return m as RegimeModule;
  return null;
}

export function isPreferModule(moduleRaw: string): boolean {
  const m = normalizeRegimeModule(moduleRaw);
  return m != null && PREFER_BASE.has(m);
}

export async function gateNewLock(
  moduleRaw: string,
  direction: "BUY" | "SELL",
  levels?: { entry: number; sl: number; tp1: number },
  now = Date.now(),
): Promise<LockGateResult> {
  const snap = await refreshDayRegime();
  return gateNewLockFromSnapshot(snap, moduleRaw, direction, now, levels);
}

export function gateNewLockFromSnapshot(
  snap: DayRegimeSnapshot,
  moduleRaw: string,
  direction: "BUY" | "SELL",
  now = Date.now(),
  levels?: { entry: number; sl: number; tp1: number },
): LockGateResult {
  const module = normalizeRegimeModule(moduleRaw);
  if (!module) {
    return { ok: true, reason: "unknown module", tier: "normal", cooldownMs: 0 };
  }
  const reg = snap.byModule[module];
  if (!reg.allowNewLock) {
    return {
      ok: false,
      reason: `regime ${reg.tier}: ${reg.reasons[0] ?? module}`,
      tier: reg.tier,
      cooldownMs: reg.cooldownMs,
    };
  }

  if (snap.sellLeanDay && module === "scalp" && direction === "BUY") {
    return {
      ok: false,
      reason: "sell-lean day — block Scalp BUY",
      tier: reg.tier,
      cooldownMs: reg.cooldownMs,
    };
  }

  const pauseMs = PREFER_BASE.has(module)
    ? POST_TP_PREFER_MS
    : POST_TP_PAUSE_MS;

  if (
    LEAN_FAMILY.has(module) &&
    snap.leanLastTp &&
    snap.leanLastTp.side === direction &&
    now - snap.leanLastTp.at < pauseMs
  ) {
    const mins = Math.ceil((pauseMs - (now - snap.leanLastTp.at)) / 60_000);
    return {
      ok: false,
      reason: `post-TP pause ${mins}m left (lean family ${direction})`,
      tier: "throttle",
      cooldownMs: pauseMs,
    };
  }

  // Learned overlay (past CSV / live history) — only if levels known
  if (
    levels &&
    Number.isFinite(levels.entry) &&
    Number.isFinite(levels.sl) &&
    Number.isFinite(levels.tp1)
  ) {
    const learned = gateLearnedLock({
      module,
      side: direction,
      entry: levels.entry,
      sl: levels.sl,
      tp1: levels.tp1,
      at: now,
    });
    if (!learned.ok) {
      return {
        ok: false,
        reason: learned.reason,
        tier: "throttle",
        cooldownMs: reg.cooldownMs || 45 * 60 * 1000,
      };
    }
  }

  return {
    ok: true,
    reason: reg.reasons[0] ?? reg.tier,
    tier: reg.tier,
    cooldownMs: reg.cooldownMs,
  };
}

export function shouldDemoFollowModule(
  moduleRaw: string,
  snap?: DayRegimeSnapshot | null,
): boolean {
  const module = normalizeRegimeModule(moduleRaw);
  if (!module) return false;
  if (module === "scalp" || module === "fractal") {
    return false;
  }
  if (!DEMO_CANDIDATES.has(module)) return false;

  const s = snap ?? cache;
  if (!s) {
    if (module === "quick_scalp") return false;
    return (
      PREFER_BASE.has(module) ||
      module === "intraday" ||
      module === "intra30"
    );
  }
  return s.byModule[module].allowDemoFollow;
}

export function demoRiskMultForModule(
  moduleRaw: string,
  snap?: DayRegimeSnapshot | null,
): number {
  const module = normalizeRegimeModule(moduleRaw);
  if (!module) return 0;
  const s = snap ?? cache;
  if (!s) return PREFER_BASE.has(module) ? 1 : 0.85;
  return s.byModule[module]?.riskMult ?? 0;
}

export function regimeSummaryLines(snap: DayRegimeSnapshot): string[] {
  return ALL_MODULES.map((m) => {
    const r = snap.byModule[m];
    const sc = r.score;
    return `${m}: ${r.tier} exec=${sc.executed} ${sc.wins}W/${sc.losses}L net=${sc.netR}R demo=${r.allowDemoFollow ? "Y" : "N"} x${r.riskMult}`;
  });
}

export { PREFER_BASE, DEMO_CANDIDATES, POST_TP_PAUSE_MS, POST_TP_PREFER_MS };
