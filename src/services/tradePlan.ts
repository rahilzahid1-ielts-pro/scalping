import type { AssetId, RegimeTag, Side, TradeLevels, TradeMode } from "../types";
import { isTooLateToEnter, minRiskPct } from "../utils/tradeSafety";

export type PlanStatus = "WAITING_ENTRY" | "IN_TRADE_HINT" | "INVALIDATED";

/** Sentinel note so callers can distinguish a regime-flip drop (allow immediate re-lock + log). */
export const REGIME_FLIP_NOTE =
  "Regime flip vs plan side — plan invalidated (trend reversed mid-session)";

/**
 * Consecutive opposing-regime closed bars required before a flip is treated as real.
 * (Only relevant while REGIME_FLIP_ENABLED is true.) Tunable from calibration data.
 */
export const REGIME_FLIP_CONFIRM_BARS = 3;

/**
 * Master switch for regime-flip invalidation.
 *
 * DISABLED — 1-year XAUUSD backtest showed the deriveRegimeTag flip is NOT
 * predictive of adverse outcomes for frozen plans:
 *   • single-bar trigger : 36.1% saved-loss (63.9% cut a would-be TP1 win)
 *   • N=3 + HTF gate      : 28.4% saved-loss (worsened, not a tuning problem)
 * Both sit well below the 50% breakeven, so acting on it live cost more winners
 * than it saved. Plans now end only via SL_HIT / TP1_HIT / price-invalidation /
 * session rollover (prior behavior).
 *
 * The measurement pipeline stays wired (regime logged per bar,
 * REGIME_FLIP_INVALIDATED + wouldHaveHitSlFirst in schema, backtest shadow):
 * flip this to `true` to re-experiment with a different flip definition later
 * without re-plumbing.
 */
export const REGIME_FLIP_ENABLED = false;

/**
 * How WAITING_ENTRY plans treat isTooLateToEnter.
 * - half_r_immediate: invalidate as soon as price runs 0.5R toward target (fb0af78)
 *   — MEASUREMENT ONLY. Isolation A/B/C showed this destroys Main Scalp edge
 *   (locks explode, touch%/avgR collapse). Do not enable in production.
 * - legacy_nested: only invalidate when price is also on the SL side of entry
 *
 * Production default is legacy_nested.
 */
export type WaitingTooLateMode = "half_r_immediate" | "legacy_nested";
export let WAITING_TOO_LATE_MODE: WaitingTooLateMode = "legacy_nested";

export function setWaitingTooLateMode(mode: WaitingTooLateMode): void {
  WAITING_TOO_LATE_MODE = mode;
}

/**
 * Trend reversed against the plan's direction.
 * Uses the SAME regime tag already logged per signal (deriveRegimeTag): no new indicator.
 */
export function isRegimeFlip(side: Side, regime: RegimeTag | null | undefined): boolean {
  if (!regime) return false;
  if (side === "SELL" && regime === "TREND_UP") return true;
  if (side === "BUY" && regime === "TREND_DOWN") return true;
  return false;
}

export interface FrozenPlan {
  assetId: AssetId;
  mode: TradeMode;
  side: Side;
  levels: TradeLevels;
  lockedAt: number;
  status: PlanStatus;
  note: string;
  /** Scores shown when this plan was frozen; do not replace with a later refresh. */
  lockedConfidence?: number;
  lockedWinProbability?: number;
  /** Intraday: UTC calendar day this session plan was locked (one zone per day). */
  sessionDate?: string;
  entryZoneLow?: number;
  entryZoneHigh?: number;
  /** Expected intraday range (SMC/PA path) — frozen at lock time. */
  safeZoneLow?: number;
  safeZoneHigh?: number;
  /**
   * Rolling count of consecutive closed bars whose regime opposed the plan side.
   * Resets to 0 when regime reverts. Flip invalidation needs it ≥ confirm bars.
   */
  flipStreak?: number;
  /**
   * SCALPING-ONLY: set when this plan was locked off a fresh trend-confirmation
   * trigger (regime just transitioned + ATR expanding + HTF agreement). Drives the
   * distinct "🔥 New trend starting" alert wording. Never set for intraday.
   */
  trendConfirmed?: boolean;
  /** Timestamp of the trend-confirmation that produced this plan (scalping only). */
  trendConfirmedAt?: number;
}

const STORAGE_KEY = "smc_trade_desk_v2";

export interface DeskSession {
  assetId: AssetId;
  mode: TradeMode;
  plan: FrozenPlan | null;
  alertsOn: boolean;
}

const DEFAULT_SESSION: DeskSession = {
  assetId: "XAUUSD",
  mode: "scalping",
  plan: null,
  alertsOn: true,
};

function isPlanLevelsUnsafe(plan: FrozenPlan): boolean {
  const room = Math.abs(plan.levels.stopLoss - plan.levels.entry);
  return room < plan.levels.entry * minRiskPct(plan.assetId) * 0.85;
}

function isValidPlan(p: unknown): p is FrozenPlan {
  if (!p || typeof p !== "object") return false;
  const plan = p as FrozenPlan;
  return (
    (plan.side === "BUY" || plan.side === "SELL") &&
    !!plan.levels &&
    typeof plan.levels.entry === "number" &&
    typeof plan.levels.stopLoss === "number" &&
    typeof plan.lockedAt === "number"
  );
}

export function loadSession(): DeskSession {
  try {
    localStorage.removeItem("smc_trade_desk_v1");
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SESSION };
    const parsed = JSON.parse(raw) as Partial<DeskSession>;
    const assetId = parsed.assetId === "XAUUSD" ? "XAUUSD" : DEFAULT_SESSION.assetId;
    const mode = parsed.mode === "scalping" || parsed.mode === "intraday" ? parsed.mode : "scalping";
    let plan = isValidPlan(parsed.plan) ? parsed.plan : null;
    // Drop plans for retired UI assets (Silver/Bitcoin).
    if (plan && plan.assetId !== "XAUUSD") plan = null;
    if (plan && isPlanLevelsUnsafe(plan)) plan = null;
    return {
      assetId,
      mode,
      plan,
      alertsOn: parsed.alertsOn !== false,
    };
  } catch {
    return { ...DEFAULT_SESSION };
  }
}

export function saveSession(session: DeskSession) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* ignore */
  }
}

export function shouldKeepFrozenPlan(
  plan: FrozenPlan | null,
  nextSide: Side,
  livePrice: number | undefined,
  /** Current PRIMARY-TF regime tag (deriveRegimeTag). */
  regime?: RegimeTag | null,
  /**
   * Higher-timeframe regime tags (e.g. 15m + 1H via computeRegime on the HTF series).
   * Flip only fires when at least one HTF also opposes the plan side.
   */
  htfRegimes?: (RegimeTag | null | undefined)[],
): FrozenPlan | null {
  if (!plan || plan.side === "WAIT") return null;

  // Regime-flip invalidation is DISABLED (see REGIME_FLIP_ENABLED). Kept behind
  // the flag — not deleted — so the measurement pipeline can be re-enabled later.
  let base: FrozenPlan = plan;
  if (REGIME_FLIP_ENABLED) {
    // Rolling confirmation counter: only sustained opposing regime counts.
    const primaryOpposing = isRegimeFlip(plan.side, regime);
    const nextStreak = primaryOpposing ? (plan.flipStreak ?? 0) + 1 : 0;
    base =
      (plan.flipStreak ?? 0) === nextStreak ? plan : { ...plan, flipStreak: nextStreak };

    // Flip fires only when BOTH gates hold:
    //  (1) opposing regime confirmed for ≥ N consecutive closed bars, AND
    //  (2) at least one higher timeframe also shows the opposing regime.
    const htfOpposing = (htfRegimes ?? []).some((r) => isRegimeFlip(plan.side, r));
    if (
      base.status !== "INVALIDATED" &&
      primaryOpposing &&
      nextStreak >= REGIME_FLIP_CONFIRM_BARS &&
      htfOpposing
    ) {
      return {
        ...base,
        status: "INVALIDATED",
        note: REGIME_FLIP_NOTE,
      };
    }
  }

  if (livePrice != null && Number.isFinite(livePrice)) {
    if (base.side === "BUY" && livePrice < base.levels.stopLoss) {
      return {
        ...base,
        status: "INVALIDATED",
        note: "SL hit. New plan only after fresh setup.",
      };
    }
    if (base.side === "SELL" && livePrice > base.levels.stopLoss) {
      return {
        ...base,
        status: "INVALIDATED",
        note: "SL hit. New plan only after fresh setup.",
      };
    }
    if (
      base.status === "WAITING_ENTRY" &&
      isTooLateToEnter(base.side, livePrice, base.levels.entry, base.levels.stopLoss)
    ) {
      if (WAITING_TOO_LATE_MODE === "legacy_nested") {
        // Pre-fb0af78: only drop when price is clearly past entry into risk.
        if (
          (base.side === "SELL" && livePrice > base.levels.entry) ||
          (base.side === "BUY" && livePrice < base.levels.entry)
        ) {
          return {
            ...base,
            status: "INVALIDATED",
            note: "Price SL zone mein — entry miss. Chase mat karo. New plan lo.",
          };
        }
      } else {
        return {
          ...base,
          status: "INVALIDATED",
          note: "Price entry se 0.5R target side nikal gayi — move miss, chase mat karo.",
        };
      }
    }
  }

  if (isPlanLevelsUnsafe(base)) {
    return {
      ...base,
      status: "INVALIDATED",
      note: "SL/TP bohot tight tha (unsafe). New plan lo.",
    };
  }

  if (nextSide === "WAIT" || nextSide === base.side) {
    return {
      ...base,
      // Never downgrade an entered trade back to WAITING_ENTRY on refresh.
      status: base.status,
      note:
        base.status === "INVALIDATED"
          ? base.note
          : base.status === "IN_TRADE_HINT"
            ? base.note
          : "Entry LOCKED. Chart pe confirm karke limit rakho — chase mat karo.",
    };
  }

  return {
    ...base,
    note: `Engine leans ${nextSide}, locked stays ${base.side} until New plan.`,
  };
}

export function createFrozenPlan(
  assetId: AssetId,
  mode: TradeMode,
  side: Side,
  levels: TradeLevels,
  lockedConfidence?: number,
  lockedWinProbability?: number,
  extras?: Pick<
    FrozenPlan,
    "sessionDate" | "entryZoneLow" | "entryZoneHigh" | "safeZoneLow" | "safeZoneHigh"
  >,
  /** Wall clock live; bar-close ms in backtest. */
  lockedAtMs: number = Date.now(),
): FrozenPlan {
  const isSession = mode === "intraday" && extras?.sessionDate;
  const plan: FrozenPlan = {
    assetId,
    mode,
    side,
    levels,
    lockedAt: lockedAtMs,
    status: "WAITING_ENTRY",
    note: isSession
      ? `Intraday zone LOCKED (${extras!.sessionDate}). Din bhar entry/SL/TP same — sirf New plan se badlega.`
      : "Limit entry LOCKED. Jab price entry pe aaye tab lo — chart se confirm.",
    lockedConfidence,
    lockedWinProbability,
    ...extras,
  };
  if (isPlanLevelsUnsafe(plan)) {
    return {
      ...plan,
      status: "INVALIDATED",
      note: "Levels unsafe (SL too tight). New plan dabao.",
    };
  }
  return plan;
}

/** Backfill locked scores on older plans that predate this field. */
export function ensureLockedScores(
  plan: FrozenPlan,
  confidence: number,
  winProbability: number,
): FrozenPlan {
  if (plan.lockedConfidence != null && plan.lockedWinProbability != null) return plan;
  return {
    ...plan,
    lockedConfidence: plan.lockedConfidence ?? confidence,
    lockedWinProbability: plan.lockedWinProbability ?? winProbability,
  };
}
