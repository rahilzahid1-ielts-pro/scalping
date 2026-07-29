/**
 * Day-adaptive module regime — soft “jo aaj jeet raha usko zyada”.
 *
 * Positive-day desk (not silent desk):
 * - Prefer (QS Pro + Cipher + Pro) keep firing — 2 SL = throttle, 3 SL = pause
 * - Day WR confidence: ≥70% → more trades; <60% (n≥3) → no new locks
 * - Post-TP same-side pause 90m across lean family (includes Pro)
 * - Chase-after-TP: block same-side if entry already ≥$8 beyond last TP entry (3h)
 * - Retrace-after-TP: block same-side if entry has pulled ≥$3 back past that TP entry
 * - Day side-stop: 2 same-side SL → prefer-only + 2h cooldown, 3 → side band
 * - Demote Scalp / Quick Scalp (fat SL killers)
 * - Demo size scales by tier; day stop / profit-protect in positiveDayDesk
 * - Friday 20:00 PKT → Mon open: no new locks
 */
import {
  buildHistoryPayload,
  karachiYmd,
  type HistoryModuleId,
  type HistoryTrade,
} from "../history/apiHistory";
import { gateLearnedLock } from "../learn/runtime";
import { isFridayCloseOrWeekend } from "../utils/marketHours";
import { findLeanOpenSameSide } from "./leanOpenSameSide";

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
  /** Entry of the most recent TP (for chase-after-win guard). */
  lastTpEntry: number | null;
  lastSlAt: number | null;
  lastSide: "BUY" | "SELL" | null;
  sellWins: number;
  buyWins: number;
  sellLosses: number;
  buyLosses: number;
  /** Most recent SL time per side (drives the day side-stop). */
  lastSlBySide: { BUY: number | null; SELL: number | null };
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
  /** Today's win rate % (null until min sample). Same as confidence. */
  winRate: number | null;
  /** Day confidence from WR — drives boost / block. */
  confidencePct: number | null;
}

export interface DayRegimeSnapshot {
  date: string;
  refreshedAt: number;
  byModule: Record<RegimeModule, ModuleRegime>;
  sellLeanDay: boolean;
  leanLastTp: {
    at: number;
    side: "BUY" | "SELL";
    entry: number | null;
  } | null;
  /**
   * Day-level same-side SL tally across every module. Daily bias forces all
   * desks onto one direction, so per-module tiers alone let same-side SLs
   * stack (24–28 Jul: 11 SELL SL out of 18 SELL fills).
   */
  sideRisk: Record<"BUY" | "SELL", { sl: number; lastSlAt: number | null }>;
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

/**
 * Same-side post-TP / chase family — after a win, don't stack another
 * SELL lower (or BUY higher) across these desks.
 * Pro included so QS Pro TP blocks Pro re-short (2026-07-27 double SL).
 */
export const LEAN_FAMILY = new Set<RegimeModule>([
  "qs_pro",
  "cipher_b",
  "quick_scalp",
  "fractal",
  "pro",
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
/** Need this many EXECUTED fills before WR confidence can block/boost. */
const CONF_MIN_SAMPLE = 3;
/** Below this WR% → no new locks today for that module. */
const CONF_BLOCK_BELOW = 60;
/** At/above this WR% → prefer boost (more trades / higher risk). */
const CONF_BOOST_AT = 70;
/** Same-side pause after lean/prefer TP (was 45m prefer / 90m other). */
const POST_TP_PAUSE_MS = 90 * 60 * 1000;
const POST_TP_PREFER_MS = 90 * 60 * 1000;
const THROTTLE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
/** Block same-side re-entry if price already extended this far past last TP entry.
 *  $8 balances trade count vs stacked SL (2026-07-27: $10 chase after win still SL'd at $12). */
const CHASE_AFTER_TP_USD = 8;
/** How long the chase-after-TP guard stays armed. */
const CHASE_AFTER_TP_MS = 3 * 60 * 60 * 1000;
/**
 * Mirror of the chase guard: after a same-side TP, block re-entry that has
 * retraced this far back past the winning entry. A pure time pause just gets
 * waited out (2026-07-28: Cipher SELL TP 18:44, QS Pro re-sold $3 higher at
 * 20:14 — exactly when the 90m pause expired — and SL'd).
 */
const RETRACE_AFTER_TP_USD = 3;
/** Same-side SL count that soft-throttles a direction for the day. */
const SIDE_SL_SOFT = 2;
/** Same-side SL count that hard-stops a direction for the rest of the day. */
const SIDE_SL_HARD = 3;
/** Quiet time after the 2nd same-side SL before prefer desks may retry. */
const SIDE_SL_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const CACHE_TTL_MS = 90_000;

let cache: DayRegimeSnapshot | null = null;
let cacheInflight: Promise<DayRegimeSnapshot> | null = null;

/** In-process TP stamps (faster than waiting for history refresh). */
const liveTpStamps: {
  module: RegimeModule;
  side: "BUY" | "SELL";
  at: number;
  entry: number | null;
}[] = [];

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
    lastTpEntry: null,
    lastSlAt: null,
    lastSide: null,
    sellWins: 0,
    buyWins: 0,
    sellLosses: 0,
    buyLosses: 0,
    lastSlBySide: { BUY: null, SELL: null },
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
      if (s.lastTpAt == null || at > s.lastTpAt) {
        s.lastTpAt = at;
        s.lastTpEntry = Number.isFinite(t.entry) ? t.entry : null;
      }
    } else {
      s.losses += 1;
      if (t.side === "SELL") s.sellLosses += 1;
      else s.buyLosses += 1;
      if (s.lastSlAt == null || at > s.lastSlAt) s.lastSlAt = at;
      const prevSide = s.lastSlBySide[t.side];
      if (prevSide == null || at > prevSide) s.lastSlBySide[t.side] = at;
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
  liveTps: {
    module: RegimeModule;
    side: "BUY" | "SELL";
    at: number;
    entry?: number | null;
  }[] = [],
): Omit<DayRegimeSnapshot, "date" | "refreshedAt"> {
  const sellWins = ALL_MODULES.reduce((a, m) => a + scores[m].sellWins, 0);
  const buyWins = ALL_MODULES.reduce((a, m) => a + scores[m].buyWins, 0);
  const sellLeanDay = sellWins >= 2 && sellWins > buyWins;

  const sideRisk: DayRegimeSnapshot["sideRisk"] = {
    BUY: { sl: 0, lastSlAt: null },
    SELL: { sl: 0, lastSlAt: null },
  };
  for (const m of ALL_MODULES) {
    const s = scores[m];
    sideRisk.BUY.sl += s.buyLosses;
    sideRisk.SELL.sl += s.sellLosses;
    for (const side of ["BUY", "SELL"] as const) {
      const at = s.lastSlBySide[side];
      const prev = sideRisk[side].lastSlAt;
      if (at != null && (prev == null || at > prev)) {
        sideRisk[side].lastSlAt = at;
      }
    }
  }

  let leanLastTp: DayRegimeSnapshot["leanLastTp"] = null;
  for (const m of LEAN_FAMILY) {
    const tp = scores[m].lastTpAt;
    if (tp == null) continue;
    const side = scores[m].lastSide;
    if (!side) continue;
    if (!leanLastTp || tp > leanLastTp.at) {
      leanLastTp = {
        at: tp,
        side,
        entry: scores[m].lastTpEntry,
      };
    }
  }
  for (const stamp of liveTps) {
    if (!LEAN_FAMILY.has(stamp.module)) continue;
    if (now - stamp.at > Math.max(POST_TP_PAUSE_MS, CHASE_AFTER_TP_MS)) continue;
    if (!leanLastTp || stamp.at > leanLastTp.at) {
      leanLastTp = {
        at: stamp.at,
        side: stamp.side,
        entry: stamp.entry ?? null,
      };
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

    let riskMult = riskMultForTier(tier, module, score);

    // --- Day WR confidence (per module) ---
    let winRate: number | null = null;
    let confidencePct: number | null = null;
    if (score.executed >= CONF_MIN_SAMPLE) {
      winRate =
        Math.round((score.wins / score.executed) * 1000) / 10;
      confidencePct = winRate;

      if (confidencePct < CONF_BLOCK_BELOW) {
        allowNewLock = false;
        allowDemoFollow = false;
        tier = "pause";
        riskMult = 0;
        reasons.push(
          `day confidence ${confidencePct}% < ${CONF_BLOCK_BELOW}% (n=${score.executed}) → no new locks`,
        );
      } else if (confidencePct >= CONF_BOOST_AT) {
        // Keep hard pause only on 3+ SL; otherwise boost volume
        if (score.losses < THREE_SL_HARD && module !== "scalp") {
          tier = "prefer";
          allowNewLock = true;
          riskMult = Math.max(riskMult, 1.25);
          cooldownMs = Math.min(
            cooldownMs > 0 ? cooldownMs : POST_TP_PREFER_MS,
            POST_TP_PREFER_MS,
          );
          if (DEMO_CANDIDATES.has(module)) allowDemoFollow = true;
          reasons.push(
            `day confidence ${confidencePct}% ≥ ${CONF_BOOST_AT}% → more trades`,
          );
        } else {
          reasons.push(
            `day confidence ${confidencePct}% but hard pause (${score.losses} SL)`,
          );
        }
      } else {
        reasons.push(
          `day confidence ${confidencePct}% (60–70 band → normal)`,
        );
      }
    } else {
      reasons.push(
        `confidence pending (<${CONF_MIN_SAMPLE} fills today)`,
      );
    }

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
      winRate,
      confidencePct,
    };
  }

  return { byModule, sellLeanDay, leanLastTp, sideRisk };
}

export function evaluateDayRegime(
  trades: HistoryTrade[],
  now = Date.now(),
  date = karachiYmd(now),
): DayRegimeSnapshot {
  const scores = scoreModulesFromTrades(trades);
  // Keep stamps for the full chase/retrace window, not just the TP pause.
  const stampWindow = Math.max(POST_TP_PAUSE_MS, CHASE_AFTER_TP_MS);
  const live = liveTpStamps.filter((s) => now - s.at <= stampWindow);
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
  entry: number | null = null,
): void {
  liveTpStamps.push({ module, side, at, entry });
  while (liveTpStamps.length > 40) liveTpStamps.shift();
  if (cache && LEAN_FAMILY.has(module)) {
    if (!cache.leanLastTp || at >= cache.leanLastTp.at) {
      cache = {
        ...cache,
        refreshedAt: at,
        leanLastTp: { at, side, entry },
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
  const weekend = isFridayCloseOrWeekend(now);
  if (weekend.blocked) {
    return {
      ok: false,
      reason: weekend.reason,
      tier: "pause",
      cooldownMs: 60 * 60 * 1000,
    };
  }

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

  // Pro late-join: don't open a twin while QS Pro / Cipher / Fractal / QS
  // already hold the same side (2026-07-29 Pro SL after lean siblings open).
  if (module === "pro") {
    const sibling = findLeanOpenSameSide(direction);
    if (sibling) {
      return {
        ok: false,
        reason: `lean late-join — ${sibling.desk} already OPEN ${direction}`,
        tier: "throttle",
        cooldownMs: 60 * 60 * 1000,
      };
    }
  }

  // Day side-stop — all desks share one direction on a biased day, so count
  // same-side SLs across modules instead of per module only.
  const sideSl = snap.sideRisk?.[direction];
  if (sideSl) {
    if (sideSl.sl >= SIDE_SL_HARD) {
      return {
        ok: false,
        reason: `day side-stop — ${sideSl.sl} ${direction} SL today, ${direction} band`,
        tier: "pause",
        cooldownMs: 4 * 60 * 60 * 1000,
      };
    }
    if (sideSl.sl >= SIDE_SL_SOFT) {
      if (!PREFER_BASE.has(module)) {
        return {
          ok: false,
          reason: `day side-throttle — ${sideSl.sl} ${direction} SL today, sirf prefer desks`,
          tier: "throttle",
          cooldownMs: SIDE_SL_COOLDOWN_MS,
        };
      }
      const since = sideSl.lastSlAt == null ? Infinity : now - sideSl.lastSlAt;
      if (since < SIDE_SL_COOLDOWN_MS) {
        const mins = Math.ceil((SIDE_SL_COOLDOWN_MS - since) / 60_000);
        return {
          ok: false,
          reason: `day side-throttle — ${sideSl.sl} ${direction} SL, ${mins}m cooldown`,
          tier: "throttle",
          cooldownMs: SIDE_SL_COOLDOWN_MS,
        };
      }
    }
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

  // After a same-side TP, don't chase further in the same direction (late entry).
  if (
    LEAN_FAMILY.has(module) &&
    snap.leanLastTp &&
    snap.leanLastTp.side === direction &&
    snap.leanLastTp.entry != null &&
    levels &&
    Number.isFinite(levels.entry) &&
    now - snap.leanLastTp.at < CHASE_AFTER_TP_MS
  ) {
    const extension =
      direction === "SELL"
        ? snap.leanLastTp.entry - levels.entry
        : levels.entry - snap.leanLastTp.entry;
    const cooldownMs = Math.min(
      CHASE_AFTER_TP_MS - (now - snap.leanLastTp.at),
      60 * 60 * 1000,
    );
    if (extension >= CHASE_AFTER_TP_USD) {
      return {
        ok: false,
        reason: `chase-after-TP block — ${direction} ${extension.toFixed(1)}$ past last TP entry`,
        tier: "throttle",
        cooldownMs,
      };
    }
    // Retraced back past the winning entry → we'd be fading the bounce that
    // followed our own TP, not riding continuation.
    if (extension <= -RETRACE_AFTER_TP_USD) {
      return {
        ok: false,
        reason: `retrace-after-TP block — ${direction} ${Math.abs(extension).toFixed(1)}$ back past last TP entry`,
        tier: "throttle",
        cooldownMs,
      };
    }
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
    const conf =
      r.confidencePct != null ? ` conf=${r.confidencePct}%` : " conf=pending";
    return `${m}: ${r.tier} exec=${sc.executed} ${sc.wins}W/${sc.losses}L net=${sc.netR}R${conf} demo=${r.allowDemoFollow ? "Y" : "N"} x${r.riskMult}`;
  });
}

export {
  PREFER_BASE,
  DEMO_CANDIDATES,
  POST_TP_PAUSE_MS,
  POST_TP_PREFER_MS,
  CONF_MIN_SAMPLE,
  CONF_BLOCK_BELOW,
  CONF_BOOST_AT,
};
