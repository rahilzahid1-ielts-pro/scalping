/**
 * SCALPING-ONLY trend-confirmation early trigger.
 *
 * Reuses the EXISTING regime classifier (computeRegime → deriveRegimeTag, the same
 * TREND_UP/TREND_DOWN/RANGE tagging used in calibration and the disabled regime-flip
 * trigger) plus the existing ATR indicator. It does NOT build a new trend detector,
 * and it is never wired into intraday's session-lock ("1 zone/day") path.
 *
 * A "fresh trend confirmation" fires once per trend run when ALL of:
 *   1. Regime has JUST transitioned into TREND_UP / TREND_DOWN (previous bars were
 *      RANGE or the opposite trend) and has now held for M consecutive closed bars.
 *   2. ATR14 is expanding vs its recent average (ATR14 > mult × avg of prior N bars).
 *   3. At least one higher timeframe (15m / 1H for scalping) agrees with the direction.
 *
 * This is only a TRIGGER for evaluation — the actual lock still goes through
 * generateSignal + canAutoLockPlan's confidence/conflict gates.
 */
import type { Candle, RegimeTag, Side } from "../types";
import { atr } from "../strategies/indicators";

/**
 * Default consecutive closed bars in the new trend direction before confirming (M).
 * Tunable per-run in the backtest via --trend-confirm-bars; live uses this default.
 */
export const TREND_CONFIRM_BARS = 4;
/**
 * How many extra bars the confirmation stays "armed" after reaching M, so an
 * IDLE scalping lock taken shortly after the transition still counts as fresh
 * (armed streak window = [M, M + TREND_FRESH_WINDOW]). Keeps it a fresh-start
 * trigger, not an old/exhausted trend.
 */
export const TREND_FRESH_WINDOW = 4;
/** ATR14 must exceed this multiple of its recent average to count as expanding. */
export const TREND_ATR_EXPANSION_MULT = 1.3;
/** Number of prior bars used for the ATR baseline average. */
export const TREND_ATR_AVG_LOOKBACK = 20;

export interface TrendTracker {
  /** Regime currently being counted (advances the streak while unchanged). */
  countedRegime: RegimeTag | null;
  /** Consecutive closed bars in `countedRegime`. */
  streak: number;
  /** Whether the confirmation EVENT was already counted for this trend run. */
  eventFiredForRun: boolean;
  /** Whether a trend-confirmed lock was already taken for the current trend run. */
  lockTagged: boolean;
  /** Last processed closed-bar time — guards against multiple ticks per bar. */
  lastBarTime: number | null;
}

export function newTrendTracker(): TrendTracker {
  return {
    countedRegime: null,
    streak: 0,
    eventFiredForRun: false,
    lockTagged: false,
    lastBarTime: null,
  };
}

/** Mark the current trend run as consumed once a trend-confirmed lock is taken. */
export function markTrendConsumed(tracker: TrendTracker): void {
  tracker.lockTagged = true;
}

/** TREND_UP → BUY, TREND_DOWN → SELL, RANGE → WAIT. */
export function regimeDir(regime: RegimeTag): Side {
  if (regime === "TREND_UP") return "BUY";
  if (regime === "TREND_DOWN") return "SELL";
  return "WAIT";
}

/** True when current ATR14 exceeds `mult` × average of the prior N ATR14 values. */
export function atrExpanding(primary: Candle[]): boolean {
  const a = atr(primary, 14);
  if (a.length < TREND_ATR_AVG_LOOKBACK + 1) return false;
  const cur = a[a.length - 1];
  const prior = a.slice(-(TREND_ATR_AVG_LOOKBACK + 1), -1);
  const avg = prior.reduce((s, v) => s + v, 0) / prior.length;
  return avg > 0 && cur > TREND_ATR_EXPANSION_MULT * avg;
}

/** At least one HTF regime matches the trend direction (15m / 1H for scalping). */
export function htfAgreesDir(
  dir: Side,
  htfRegimes: (RegimeTag | null | undefined)[],
): boolean {
  if (dir === "BUY") return htfRegimes.some((r) => r === "TREND_UP");
  if (dir === "SELL") return htfRegimes.some((r) => r === "TREND_DOWN");
  return false;
}

/**
 * Advance the per-key tracker with the current CLOSED-bar regime and report:
 *  - `newEvent`: the confirmation TRIGGER fired this bar (once per trend run — the
 *    first bar where regime held M bars + ATR expanding + HTF agrees). Independent
 *    of whether a scalping trade is actually taken. Used to count alerts fired.
 *  - `armed`: a fresh trend-confirmed lock may still be tagged this bar (within the
 *    freshness window [M, M+TREND_FRESH_WINDOW] and not yet locked this run). The
 *    consumer calls `markTrendConsumed` once it locks a trend-confirmed plan.
 * `confirmBars` (M) is tunable per run; defaults to TREND_CONFIRM_BARS.
 * Idempotent within a single bar: repeated calls with the same `barTime` re-report
 * without advancing the streak or re-firing the event.
 */
export function evaluateTrendConfirm(
  tracker: TrendTracker,
  regime: RegimeTag,
  primary: Candle[],
  htfRegimes: (RegimeTag | null | undefined)[],
  barTime: number,
  confirmBars: number = TREND_CONFIRM_BARS,
): { armed: boolean; dir: Side; newEvent: boolean } {
  const dir = regimeDir(regime);

  // Same bar already processed (many ticks per bar live) — do not advance streak.
  if (tracker.lastBarTime !== barTime) {
    tracker.lastBarTime = barTime;
    if (regime === tracker.countedRegime) {
      tracker.streak += 1;
    } else {
      tracker.countedRegime = regime;
      tracker.streak = 1;
      tracker.eventFiredForRun = false; // new run (transition into RANGE or trend)
      tracker.lockTagged = false;
    }
  }

  if (dir === "WAIT") return { armed: false, dir, newEvent: false };

  const base =
    tracker.streak >= confirmBars &&
    atrExpanding(primary) &&
    htfAgreesDir(dir, htfRegimes);

  const newEvent = base && !tracker.eventFiredForRun;
  if (newEvent) tracker.eventFiredForRun = true;

  const armed =
    base && tracker.streak <= confirmBars + TREND_FRESH_WINDOW && !tracker.lockTagged;

  return { armed, dir, newEvent };
}
