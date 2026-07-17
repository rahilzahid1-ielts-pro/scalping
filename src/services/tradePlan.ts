import type { AssetId, Side, TradeLevels, TradeMode } from "../types";
import { isTooLateToEnter, minRiskPct } from "../utils/tradeSafety";

export type PlanStatus = "WAITING_ENTRY" | "IN_TRADE_HINT" | "INVALIDATED";

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
    const assetId =
      parsed.assetId === "XAUUSD" || parsed.assetId === "XAGUSD" || parsed.assetId === "BTCUSD"
        ? parsed.assetId
        : DEFAULT_SESSION.assetId;
    const mode = parsed.mode === "scalping" || parsed.mode === "intraday" ? parsed.mode : "scalping";
    let plan = isValidPlan(parsed.plan) ? parsed.plan : null;
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
): FrozenPlan | null {
  if (!plan || plan.side === "WAIT") return null;

  if (livePrice != null && Number.isFinite(livePrice)) {
    if (plan.side === "BUY" && livePrice < plan.levels.stopLoss) {
      return {
        ...plan,
        status: "INVALIDATED",
        note: "SL hit. New plan only after fresh setup.",
      };
    }
    if (plan.side === "SELL" && livePrice > plan.levels.stopLoss) {
      return {
        ...plan,
        status: "INVALIDATED",
        note: "SL hit. New plan only after fresh setup.",
      };
    }
    if (
      plan.status === "WAITING_ENTRY" &&
      isTooLateToEnter(plan.side, livePrice, plan.levels.entry, plan.levels.stopLoss)
    ) {
      // Only invalidate when clearly past entry deep into risk — keep waiting if still below entry for SELL
      if (
        (plan.side === "SELL" && livePrice > plan.levels.entry) ||
        (plan.side === "BUY" && livePrice < plan.levels.entry)
      ) {
        return {
          ...plan,
          status: "INVALIDATED",
          note: "Price SL zone mein — entry miss. Chase mat karo. New plan lo.",
        };
      }
    }
  }

  if (isPlanLevelsUnsafe(plan)) {
    return {
      ...plan,
      status: "INVALIDATED",
      note: "SL/TP bohot tight tha (unsafe). New plan lo.",
    };
  }

  if (nextSide === "WAIT" || nextSide === plan.side) {
    return {
      ...plan,
      // Never downgrade an entered trade back to WAITING_ENTRY on refresh.
      status: plan.status,
      note:
        plan.status === "INVALIDATED"
          ? plan.note
          : plan.status === "IN_TRADE_HINT"
            ? plan.note
          : "Entry LOCKED. Chart pe confirm karke limit rakho — chase mat karo.",
    };
  }

  return {
    ...plan,
    note: `Engine leans ${nextSide}, locked stays ${plan.side} until New plan.`,
  };
}

export function createFrozenPlan(
  assetId: AssetId,
  mode: TradeMode,
  side: Side,
  levels: TradeLevels,
  lockedConfidence?: number,
  lockedWinProbability?: number,
): FrozenPlan {
  const plan: FrozenPlan = {
    assetId,
    mode,
    side,
    levels,
    lockedAt: Date.now(),
    status: "WAITING_ENTRY",
    note: "Limit entry LOCKED. Jab price entry pe aaye tab lo — chart se confirm.",
    lockedConfidence,
    lockedWinProbability,
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
