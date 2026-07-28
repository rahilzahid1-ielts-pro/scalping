/**
 * Exit policies — how much of a plan we bank at each level and where the stop
 * sits afterwards.
 *
 * Why this exists: every desk caps its target at 1.5–1.6R and the demo engine
 * closed the *whole* position at TP1 (0.85R). On 27–28 Jul gold ran $64 in the
 * one direction the desks were allowed to trade and the book still finished
 * −1.6R, because no trade could ever return more than ~1.5R. A policy that
 * banks part of the position and lets a runner trail is the only way a trend
 * pays for the chop around it.
 *
 * Everything here is pure so the same code runs in the live demo engine and in
 * the walk-forward comparison (`scripts/backtestExitPolicy.ts`).
 */
import type { Candle } from "../types";

export type ExitPolicyId =
  | "fixed_tp1"
  | "scale_be"
  | "runner_ladder"
  /** Trail behind an N-bar swing extreme — needs bar history. */
  | "runner_trail"
  /**
   * Trail a fixed R distance behind the best excursion so far. Equivalent in
   * spirit to `runner_trail` but implementable from a polled price alone, which
   * is all the live demo resolver has.
   */
  | "runner_trail_peak";

export type Side = "BUY" | "SELL";

export interface ExitLeg {
  /** Portion of the original position closed here (fractions sum to 1). */
  fraction: number;
  /** R multiple of the original risk. */
  rr: number;
  label: string;
}

export interface ExitPlan {
  policy: ExitPolicyId;
  side: Side;
  entry: number;
  sl: number;
  risk: number;
  legs: ExitLeg[];
  /** Price levels for each leg, same order as `legs`. */
  levels: number[];
  /**
   * Stop price once `k` legs have filled. Index 0 is the original SL, so this
   * array is `legs.length` long (the last leg closes the plan).
   */
  stopAfter: number[];
  /** Once this many legs have filled, trail the remainder. null = never. */
  trailAfterLegs: number | null;
  /** Lookback for the trailing extreme, in primary-TF bars. */
  trailBars: number;
  /** Trail this many R behind the peak excursion (peak mode). */
  trailPeakR: number | null;
}

export interface ExitResult {
  realizedR: number;
  /** What closed the last portion. */
  exitKind: "STOP" | "TRAIL" | "TARGET" | "OPEN";
  legsFilled: number;
  barsHeld: number;
  /** Best R the runner reached before exiting (diagnostic). */
  peakR: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function rAtPrice(
  side: Side,
  entry: number,
  risk: number,
  price: number,
): number {
  if (!(risk > 0)) return 0;
  return side === "BUY" ? (price - entry) / risk : (entry - price) / risk;
}

function priceAtR(side: Side, entry: number, risk: number, rr: number): number {
  return side === "BUY" ? entry + risk * rr : entry - risk * rr;
}

/** Trend regimes get the runner ladder; everything else banks fast. */
export function isTrendRegime(regime: string | null | undefined): boolean {
  const r = String(regime ?? "").toUpperCase();
  return r.includes("TREND");
}

export interface LadderSpec {
  legs: ExitLeg[];
  /** Stop as an R multiple after k legs; null = keep previous stop. */
  stopRAfter: (number | null)[];
  trailAfterLegs: number | null;
  trailBars: number;
  trailPeakR: number | null;
}

/** Tunables for the trend runner, exposed so the sweep can search them. */
export interface RunnerTune {
  /** Portion banked at the first target. */
  bankFraction: number;
  /** R multiple of the first target. */
  bankRr: number;
  /** Bars in the trailing extreme lookback (swing mode). */
  trailBars: number;
  /** R distance behind the peak excursion (peak mode). */
  trailPeakR: number;
}

/**
 * Chosen from a grid search over QS Pro signals on four history windows
 * (`scripts/sweepRunnerTune.ts`, `scripts/pickRunnerTune.ts`). Every cell in
 * the grid beat the old full-close-at-TP1 baseline, so this is not a
 * knife-edge fit. Baseline → this cell:
 *
 *    180d   totalR  101.7 →  142.9  (+40%)   maxDD  −4.2 →  −4.2
 *    365d   totalR  210.7 →  289.6  (+37%)   maxDD  −5.3 →  −5.8
 *    730d   totalR  423.7 →  577.1  (+36%)   maxDD  −5.3 →  −6.0
 *   1460d   totalR  751.7 → 1009.9  (+34%)   maxDD −10.3 → −11.1
 *
 * Wider trails looked better on short windows but on the 1460d sample they
 * returned the same while drawdown grew from −11 to −22 R, so the short-window
 * gain was noise and the risk was not. 0.5R had the best return/drawdown ratio
 * in every window.
 *
 * Banking 30% at 1R and moving the stop to breakeven guarantees +0.30R once the
 * first target fills, which is why the hit rate only slips ~74% → ~69%.
 */
export const DEFAULT_RUNNER_TUNE: RunnerTune = {
  bankFraction: 0.3,
  bankRr: 1.0,
  trailBars: 8,
  trailPeakR: 0.5,
};

/** Policy the live desks run. Peak-trail needs only a polled price. */
export const LIVE_EXIT_POLICY: ExitPolicyId = "runner_trail_peak";

function ladderFor(
  policy: ExitPolicyId,
  trend: boolean,
  tune: RunnerTune = DEFAULT_RUNNER_TUNE,
): LadderSpec {
  /** Bank the whole position at TP1 — the pre-runner demo behaviour. */
  const bankAllAtTp1: LadderSpec = {
    legs: [{ fraction: 1, rr: 0.85, label: "TP1" }],
    stopRAfter: [null],
    trailAfterLegs: null,
    trailBars: 0,
    trailPeakR: null,
  };

  if (policy === "fixed_tp1") return bankAllAtTp1;

  if (policy === "scale_be") {
    return {
      legs: [
        { fraction: 0.5, rr: 0.85, label: "TP1" },
        { fraction: 0.5, rr: 1.5, label: "TP2" },
      ],
      stopRAfter: [0, null],
      trailAfterLegs: null,
      trailBars: 0,
      trailPeakR: null,
    };
  }

  if (policy === "runner_ladder") {
    if (!trend) {
      return {
        legs: [
          { fraction: 0.5, rr: 0.85, label: "TP1" },
          { fraction: 0.5, rr: 1.5, label: "TP2" },
        ],
        stopRAfter: [0, null],
        trailAfterLegs: null,
        trailBars: 0,
        trailPeakR: null,
      };
    }
    return {
      legs: [
        { fraction: 1 / 3, rr: 1.0, label: "TP1" },
        { fraction: 1 / 3, rr: 2.0, label: "TP2" },
        { fraction: 1 / 3, rr: 3.5, label: "TP3" },
      ],
      // BE after TP1, lock TP1 after TP2
      stopRAfter: [0, 1.0, null],
      trailAfterLegs: null,
      trailBars: 0,
      trailPeakR: null,
    };
  }

  // Runner policies: bank part fast, then ride the remainder on a trail.
  // Range regimes bank everything at TP1 — the sweep showed the runner adds
  // nothing without a trend to ride (avgR 0.41 fixed vs 0.37 scaled).
  if (!trend) return bankAllAtTp1;

  const peak = policy === "runner_trail_peak";
  return {
    legs: [
      { fraction: tune.bankFraction, rr: tune.bankRr, label: "TP1" },
      // Far target that normally never fills — the trail is the real exit.
      { fraction: 1 - tune.bankFraction, rr: 12, label: "RUN" },
    ],
    stopRAfter: [0, null],
    trailAfterLegs: 1,
    trailBars: peak ? 0 : tune.trailBars,
    trailPeakR: peak ? tune.trailPeakR : null,
  };
}

export function buildExitPlan(input: {
  policy: ExitPolicyId;
  side: Side;
  entry: number;
  sl: number;
  regime?: string | null;
  tune?: RunnerTune;
}): ExitPlan {
  const risk = Math.abs(input.entry - input.sl);
  const spec = ladderFor(
    input.policy,
    isTrendRegime(input.regime),
    input.tune ?? DEFAULT_RUNNER_TUNE,
  );
  const levels = spec.legs.map((l) =>
    priceAtR(input.side, input.entry, risk, l.rr),
  );
  // null in `stopRAfter` means "leave the stop where it was".
  const stopAfter: number[] = [];
  let prevStop = input.sl;
  for (const r of spec.stopRAfter) {
    prevStop =
      r == null ? prevStop : priceAtR(input.side, input.entry, risk, r);
    stopAfter.push(prevStop);
  }
  return {
    policy: input.policy,
    side: input.side,
    entry: input.entry,
    sl: input.sl,
    risk,
    legs: spec.legs,
    levels,
    stopAfter,
    trailAfterLegs: spec.trailAfterLegs,
    trailBars: spec.trailBars,
    trailPeakR: spec.trailPeakR,
  };
}

/** Mutable runner state, persisted between price polls. */
export interface RunnerState {
  /** How many legs have filled. */
  filled: number;
  /** R already banked from filled legs. */
  bankedR: number;
  /** Current effective stop price. */
  stop: number;
  /** Best price seen in our favour (drives the peak trail). */
  peakPrice: number;
}

export interface RunnerFill {
  label: string;
  level: number;
  fraction: number;
  /** R contributed by this leg (already weighted by fraction). */
  r: number;
}

export interface RunnerStep {
  state: RunnerState;
  /** Legs that filled on this tick (partial banks). */
  fills: RunnerFill[];
  /** Non-null once the plan is fully settled. */
  closed:
    | null
    | {
        totalR: number;
        kind: "STOP" | "TRAIL" | "TARGET";
        exitPrice: number;
        /** R from the portion that closed on this tick. */
        remainderR: number;
        remainderFraction: number;
      };
}

export function initialRunnerState(plan: ExitPlan): RunnerState {
  return { filled: 0, bankedR: 0, stop: plan.sl, peakPrice: plan.entry };
}

function tighten(side: Side, stop: number, next: number): number {
  return side === "BUY" ? Math.max(stop, next) : Math.min(stop, next);
}

/**
 * Advance a runner one polled price. Same rules as `simulateExit` (stop wins on
 * ambiguity), reduced to a single price point so the live demo resolver and the
 * walk-forward comparison cannot drift apart.
 */
export function advanceRunnerOnPrice(
  plan: ExitPlan,
  prev: RunnerState,
  price: number,
): RunnerStep {
  const { side, entry, risk } = plan;
  const rAt = (px: number) => rAtPrice(side, entry, risk, px);
  const state: RunnerState = { ...prev };
  const fills: RunnerFill[] = [];

  if (!Number.isFinite(price) || price <= 0) {
    return { state, fills, closed: null };
  }

  const remainingFraction = () =>
    Math.max(
      0,
      1 -
        plan.legs
          .slice(0, state.filled)
          .reduce((a, l) => a + l.fraction, 0),
    );

  // The stop was set from prices we had already seen, so it applies now.
  if (stopTouched(side, state.stop, price, price)) {
    const remainder = remainingFraction();
    const remainderR = remainder * rAt(state.stop);
    return {
      state,
      fills,
      closed: {
        totalR: round3(state.bankedR + remainderR),
        kind: state.filled > 0 ? "TRAIL" : "STOP",
        exitPrice: state.stop,
        remainderR: round3(remainderR),
        remainderFraction: remainder,
      },
    };
  }

  while (
    state.filled < plan.legs.length &&
    targetTouched(side, plan.levels[state.filled], price, price)
  ) {
    const leg = plan.legs[state.filled];
    const level = plan.levels[state.filled];
    const r = leg.fraction * rAt(level);
    state.bankedR = round3(state.bankedR + r);
    state.filled += 1;
    fills.push({ label: leg.label, level, fraction: leg.fraction, r: round3(r) });
    const next = plan.stopAfter[state.filled - 1];
    if (Number.isFinite(next)) state.stop = tighten(side, state.stop, next);
  }

  if (state.filled >= plan.legs.length) {
    return {
      state,
      fills,
      closed: {
        totalR: round3(state.bankedR),
        kind: "TARGET",
        exitPrice: plan.levels[plan.levels.length - 1],
        remainderR: 0,
        remainderFraction: 0,
      },
    };
  }

  const favourable =
    side === "BUY"
      ? Math.max(state.peakPrice, price)
      : Math.min(state.peakPrice, price);
  state.peakPrice = favourable;

  const trailing =
    plan.trailAfterLegs != null && state.filled >= plan.trailAfterLegs;
  if (trailing) {
    const level =
      plan.trailPeakR != null
        ? priceAtR(side, entry, risk, rAt(state.peakPrice) - plan.trailPeakR)
        : null;
    if (level != null) state.stop = tighten(side, state.stop, level);
  }

  return { state, fills, closed: null };
}

/** True when `price` is at or beyond a stop for `side`. */
function stopTouched(side: Side, stop: number, high: number, low: number): boolean {
  return side === "BUY" ? low <= stop : high >= stop;
}

/** True when `price` is at or beyond a target for `side`. */
function targetTouched(
  side: Side,
  level: number,
  high: number,
  low: number,
): boolean {
  return side === "BUY" ? high >= level : low <= level;
}

/** Swing trail: hide behind the extreme of the last `bars` completed candles. */
function trailLevel(
  side: Side,
  bars: Candle[],
  index: number,
  lookback: number,
): number | null {
  const from = Math.max(0, index - lookback + 1);
  if (index < from) return null;
  let level = side === "BUY" ? Infinity : -Infinity;
  for (let i = from; i <= index; i += 1) {
    const v = side === "BUY" ? bars[i].low : bars[i].high;
    if (side === "BUY" ? v < level : v > level) level = v;
  }
  return Number.isFinite(level) ? level : null;
}

/**
 * Walk `bars` from `fromIndex` and settle the plan.
 *
 * Conservative on ambiguity, matching `resolveGapAmongLevels`: when a bar
 * touches both the stop and a target, the stop wins.
 */
export function simulateExit(
  plan: ExitPlan,
  bars: Candle[],
  fromIndex: number,
): ExitResult {
  const { side, entry, risk } = plan;
  const rAt = (px: number) => rAtPrice(side, entry, risk, px);

  let filled = 0;
  let bankedR = 0;
  let remaining = 1;
  let stop = plan.sl;
  let trailing = false;
  let peakR = 0;

  for (let i = fromIndex; i < bars.length; i += 1) {
    const bar = bars[i];
    const favourable = side === "BUY" ? bar.high : bar.low;
    const excursion = rAt(favourable);
    if (excursion > peakR) peakR = excursion;

    if (stopTouched(side, stop, bar.high, bar.low)) {
      bankedR += remaining * rAt(stop);
      return {
        realizedR: round3(bankedR),
        exitKind: trailing ? "TRAIL" : "STOP",
        legsFilled: filled,
        barsHeld: i - fromIndex + 1,
        peakR: round3(peakR),
      };
    }

    // A single bar can sweep several targets; fill them in order.
    while (
      filled < plan.legs.length &&
      targetTouched(side, plan.levels[filled], bar.high, bar.low)
    ) {
      bankedR += plan.legs[filled].fraction * rAt(plan.levels[filled]);
      remaining -= plan.legs[filled].fraction;
      filled += 1;
      const next = plan.stopAfter[filled - 1];
      if (Number.isFinite(next)) {
        stop = side === "BUY" ? Math.max(stop, next) : Math.min(stop, next);
      }
      if (plan.trailAfterLegs != null && filled >= plan.trailAfterLegs) {
        trailing = true;
      }
    }

    if (filled >= plan.legs.length || remaining <= 1e-9) {
      return {
        realizedR: round3(bankedR),
        exitKind: "TARGET",
        legsFilled: filled,
        barsHeld: i - fromIndex + 1,
        peakR: round3(peakR),
      };
    }

    // Trail from what we have seen up to and including this bar; it takes
    // effect on the next one. That matches live polling, which can only react
    // to a peak it has already observed.
    if (trailing) {
      const t =
        plan.trailPeakR != null
          ? priceAtR(side, entry, risk, peakR - plan.trailPeakR)
          : trailLevel(side, bars, i, plan.trailBars);
      if (t != null) {
        stop = side === "BUY" ? Math.max(stop, t) : Math.min(stop, t);
      }
    }
  }

  // Ran out of data — mark to last close so the comparison stays honest.
  const last = bars[bars.length - 1];
  if (last && remaining > 1e-9) bankedR += remaining * rAt(last.close);
  return {
    realizedR: round3(bankedR),
    exitKind: "OPEN",
    legsFilled: filled,
    barsHeld: Math.max(0, bars.length - fromIndex),
    peakR: round3(peakR),
  };
}
