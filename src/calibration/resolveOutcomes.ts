import {
  listActiveSignalsForSymbol,
  listAllSignals,
  listRegimeFlipPendingForSymbol,
  updateSignal,
  findByPlanKey,
} from "./db";
import { computeRealizedRFull, realizedRAtExit } from "./realizedR";
import type { LoggedSignal, SignalOutcome } from "./types";
import {
  buildExitPlan,
  rAtPrice,
  type ExitPolicyId,
} from "../exits/exitPolicy";
import { noteLoggedSignalForLearn } from "../learn/liveRuntime";

export interface PriceTick {
  price: number;
  /** Optional bar context for gap resolution */
  open?: number;
  high?: number;
  low?: number;
}

/**
 * Exit policy for advanceSignalOnBar.
 * - legacy: current keep/compare behaviour (TP1 marks WIN, plan stays open for TP2/BE)
 * - fixed_tp1: bank 100% at first TP1 touch (demo pre-runner)
 * - runner_trail_peak: bank 30% @ 1R in trend, trail remainder 0.5R behind peak
 */
export type AdvanceExitPolicy = "legacy" | ExitPolicyId;

export interface AdvanceBarOpts {
  exitPolicy?: AdvanceExitPolicy;
}

/** Ephemeral runner fields kept on the in-memory LoggedSignal during resolution. */
export type RunnerFields = {
  exitPolicy?: AdvanceExitPolicy;
  runnerPeak?: number;
  runnerStop?: number;
  runnerBankedR?: number;
  runnerRemaining?: number;
  runnerFarTarget?: number;
};

export type AdvancingSignal = LoggedSignal & RunnerFields;

type LevelKind = "SL" | "TP1" | "TP2" | "TP3" | "BE_SL" | "TRAIL";

interface LevelCandidate {
  kind: LevelKind;
  level: number;
}

function levelTouched(
  side: "BUY" | "SELL",
  kind: LevelKind,
  level: number,
  high: number,
  low: number,
): boolean {
  const isStop = kind === "SL" || kind === "BE_SL" || kind === "TRAIL";
  if (side === "BUY") {
    return isStop ? low <= level : high >= level;
  }
  return isStop ? high >= level : low <= level;
}

/**
 * Worst-case gap resolution when multiple levels lie inside the bar range.
 * Prefer the level closer to `open`; ties / ambiguity → SL / BE_SL / TRAIL (never optimistic TP).
 */
export function resolveGapAmongLevels(
  side: "BUY" | "SELL",
  open: number,
  high: number,
  low: number,
  candidates: LevelCandidate[],
): LevelCandidate | null {
  const hit = candidates.filter((c) => levelTouched(side, c.kind, c.level, high, low));
  if (hit.length === 0) return null;
  if (hit.length === 1) return hit[0];

  hit.sort((a, b) => {
    const da = Math.abs(open - a.level);
    const db = Math.abs(open - b.level);
    if (da !== db) return da - db;
    const aSl = a.kind === "SL" || a.kind === "BE_SL" || a.kind === "TRAIL" ? 0 : 1;
    const bSl = b.kind === "SL" || b.kind === "BE_SL" || b.kind === "TRAIL" ? 0 : 1;
    return aSl - bSl;
  });
  return hit[0];
}

/** @deprecated Prefer resolveGapAmongLevels — kept for callers expecting TP1 vs SL only */
export function resolveGapOutcome(
  side: "BUY" | "SELL",
  open: number,
  high: number,
  low: number,
  sl: number,
  tp1: number,
): SignalOutcome | null {
  const winner = resolveGapAmongLevels(side, open, high, low, [
    { kind: "SL", level: sl },
    { kind: "TP1", level: tp1 },
  ]);
  if (!winner) return null;
  if (winner.kind === "SL") return "SL_HIT";
  if (winner.kind === "TP1") return "TP1_HIT";
  return null;
}

function barBounds(tick: PriceTick): { open: number; high: number; low: number; price: number } {
  const price = tick.price;
  const high = Math.max(tick.high ?? price, tick.low ?? price, price);
  const low = Math.min(tick.high ?? price, tick.low ?? price, price);
  const open = tick.open ?? price;
  return { open, high, low, price };
}

function applyTp1Resolution(
  sig: LoggedSignal,
  winner: LevelCandidate,
  now: number,
  note: string,
  /** When true, bank 100% at TP1 and close (fixed_tp1). */
  closeFullOnTp1 = false,
): LoggedSignal {
  if (winner.kind === "SL") {
    sig.outcome = "SL_HIT";
    sig.outcomeTp1 = "LOSS";
    sig.resolvedAt = now;
    sig.realizedR = -1;
    sig.realizedRFull = -1;
    sig.fullPlanClosed = true;
    sig.resolveNote = note;
    return sig;
  }

  // TP1 first → primary WIN
  sig.outcome = "TP1_HIT";
  sig.outcomeTp1 = "WIN";
  sig.resolvedAt = now;
  sig.tp1HitAt = now;
  sig.realizedR =
    Math.round(realizedRAtExit(sig.side, sig.entry, sig.sl, sig.tp1) * 1000) / 1000;
  if (closeFullOnTp1) {
    sig.realizedRFull = sig.realizedR;
    sig.fullPlanClosed = true;
    sig.resolveNote = note;
    return sig;
  }
  sig.realizedRFull = computeRealizedRFull(sig);
  sig.fullPlanClosed = false;
  sig.resolveNote = note;
  return sig;
}

function applyPostTp1(
  sig: LoggedSignal,
  winner: LevelCandidate,
  now: number,
  note: string,
): LoggedSignal {
  if (winner.kind === "BE_SL") {
    sig.slAfterTp1 = true;
    sig.slAfterTp1At = now;
    sig.fullPlanClosed = true;
    sig.realizedRFull = computeRealizedRFull(sig);
    sig.resolveNote = note;
    return sig;
  }

  if (winner.kind === "TP2") {
    sig.tp2Hit = true;
    sig.tp2HitAt = now;
    // Intraday (and any plan where TP2 is the last runner) must close the full
    // plan on TP2 — otherwise History stays "active" and the desk never unlocks.
    const tp3Beyond =
      sig.tp3 != null &&
      Number.isFinite(sig.tp3) &&
      (sig.side === "BUY" ? sig.tp3 > sig.tp2 + 1e-9 : sig.tp3 < sig.tp2 - 1e-9);
    if (!tp3Beyond) {
      sig.tp3Hit = true;
      sig.tp3HitAt = now;
      sig.fullPlanClosed = true;
    }
  }
  if (winner.kind === "TP3") {
    // Price reached TP3 ⇒ TP2 was also available on the path
    if (!sig.tp2Hit) {
      sig.tp2Hit = true;
      sig.tp2HitAt = now;
    }
    sig.tp3Hit = true;
    sig.tp3HitAt = now;
    sig.fullPlanClosed = true;
  }

  sig.realizedRFull = computeRealizedRFull(sig);
  if (sig.tp3Hit) sig.fullPlanClosed = true;
  sig.resolveNote = note;
  return sig;
}

function stampEntryIfTouched(
  sig: LoggedSignal,
  high: number,
  low: number,
  now: number,
): boolean {
  if (sig.zoneTouchedAt == null && low <= sig.entry && high >= sig.entry) {
    sig.zoneTouchedAt = now;
    return true;
  }
  return false;
}

/** Legacy keep/compare path: TP1 WIN leaves plan open for TP2/BE scale-out. */
function advanceLegacy(
  sig: LoggedSignal,
  tick: PriceTick,
  now: number,
): LoggedSignal | null {
  const { open, high, low } = barBounds(tick);

  if (sig.outcome === "OPEN" && sig.outcomeTp1 == null) {
    const stampedEntry = stampEntryIfTouched(sig, high, low, now);
    if (sig.zoneTouchedAt == null) return null;

    const winner = resolveGapAmongLevels(sig.side, open, high, low, [
      { kind: "SL", level: sig.sl },
      { kind: "TP1", level: sig.tp1 },
    ]);
    if (!winner) return stampedEntry ? sig : null;
    const note =
      winner.kind === "SL"
        ? "SL before TP1 (gap/tick)"
        : "TP1 before SL (gap/tick)";
    return applyTp1Resolution(sig, winner, now, note, false);
  }

  if (sig.outcomeTp1 === "WIN" && !sig.fullPlanClosed) {
    const candidates: LevelCandidate[] = [{ kind: "BE_SL", level: sig.entry }];
    if (!sig.tp2Hit) candidates.push({ kind: "TP2", level: sig.tp2 });
    if (!sig.tp3Hit) candidates.push({ kind: "TP3", level: sig.tp3 });

    const winner = resolveGapAmongLevels(sig.side, open, high, low, candidates);
    if (!winner) return null;

    const note =
      winner.kind === "BE_SL"
        ? "Breakeven SL after TP1"
        : `${winner.kind} hit after TP1`;
    return applyPostTp1(sig, winner, now, note);
  }

  return null;
}

/**
 * Bank 100% at plan TP1 (sig.tp1) — same R as keep/compare `realizedR`, but
 * closes the full plan so equity uses that R (not 1/3 scale-out).
 */
function advanceFixedTp1(
  sig: LoggedSignal,
  tick: PriceTick,
  now: number,
): LoggedSignal | null {
  if (sig.fullPlanClosed) return null;
  if (sig.outcomeTp1 != null) return null;

  const { open, high, low } = barBounds(tick);
  const stampedEntry = stampEntryIfTouched(sig, high, low, now);
  if (sig.zoneTouchedAt == null) return null;

  const winner = resolveGapAmongLevels(sig.side, open, high, low, [
    { kind: "SL", level: sig.sl },
    { kind: "TP1", level: sig.tp1 },
  ]);
  if (!winner) return stampedEntry ? sig : null;
  const note =
    winner.kind === "SL"
      ? "SL before TP1 (fixed_tp1)"
      : "TP1 full bank (fixed_tp1)";
  return applyTp1Resolution(sig, winner, now, note, true);
}

function favourableExtreme(
  side: "BUY" | "SELL",
  high: number,
  low: number,
): number {
  return side === "BUY" ? high : low;
}

function trailStopFromPeak(
  side: "BUY" | "SELL",
  entry: number,
  risk: number,
  peak: number,
  trailPeakR: number,
): number {
  const peakR = rAtPrice(side, entry, risk, peak);
  const stopR = peakR - trailPeakR;
  return side === "BUY" ? entry + risk * stopR : entry - risk * stopR;
}

/**
 * runner_trail_peak inside the session-lock resolver:
 * trend → bank bankFraction @ bankRr, BE, trail remainder trailPeakR behind peak;
 * range → same as fixed_tp1 (full bank at plan TP1).
 */
function advanceRunnerTrailPeak(
  sig: AdvancingSignal,
  tick: PriceTick,
  now: number,
): LoggedSignal | null {
  if (sig.fullPlanClosed) return null;

  const { open, high, low } = barBounds(tick);
  const stampedEntry = stampEntryIfTouched(sig, high, low, now);
  if (sig.zoneTouchedAt == null) return null;

  const plan = buildExitPlan({
    policy: "runner_trail_peak",
    side: sig.side,
    entry: sig.entry,
    sl: sig.sl,
    regime: sig.regime,
  });

  // Range / non-trend: bankAllAtTp1 uses 0.85R synthetic — for A-vs-A' parity with
  // keep/compare we still settle on plan TP1 when the ladder is a single full bank.
  if (plan.legs.length === 1 && plan.legs[0].fraction >= 1 - 1e-9) {
    const winner = resolveGapAmongLevels(sig.side, open, high, low, [
      { kind: "SL", level: sig.sl },
      { kind: "TP1", level: sig.tp1 },
    ]);
    if (!winner) return stampedEntry ? sig : null;
    const note =
      winner.kind === "SL"
        ? "SL before TP1 (runner/range→fixed)"
        : "TP1 full bank (runner/range→fixed)";
    return applyTp1Resolution(sig, winner, now, note, true);
  }

  const risk = plan.risk || Math.abs(sig.entry - sig.sl) || 1e-9;
  const bankLevel = plan.levels[0];
  const bankFrac = plan.legs[0].fraction;
  const trailPeakR = plan.trailPeakR ?? 0.5;

  // Phase 1: original SL vs first bank target
  if (sig.outcome === "OPEN" && sig.outcomeTp1 == null) {
    const winner = resolveGapAmongLevels(sig.side, open, high, low, [
      { kind: "SL", level: sig.sl },
      { kind: "TP1", level: bankLevel },
    ]);
    if (!winner) return stampedEntry ? sig : null;

    if (winner.kind === "SL") {
      return applyTp1Resolution(sig, winner, now, "SL before bank (runner)", true);
    }

    const bankR = bankFrac * rAtPrice(sig.side, sig.entry, risk, bankLevel);
    sig.outcome = "TP1_HIT";
    sig.outcomeTp1 = "WIN";
    sig.resolvedAt = now;
    sig.tp1HitAt = now;
    sig.runnerBankedR = Math.round(bankR * 1000) / 1000;
    sig.runnerRemaining = 1 - bankFrac;
    sig.runnerStop = plan.stopAfter[0]; // BE
    sig.runnerPeak = favourableExtreme(sig.side, high, low);
    // Trail from this bar's peak takes effect next bar (matches simulateExit).
    if (plan.trailAfterLegs != null && plan.trailAfterLegs <= 1) {
      sig.runnerStop = trailStopFromPeak(
        sig.side,
        sig.entry,
        risk,
        sig.runnerPeak,
        trailPeakR,
      );
      // Never loosen below BE after bank
      const be = plan.stopAfter[0];
      sig.runnerStop =
        sig.side === "BUY"
          ? Math.max(sig.runnerStop, be)
          : Math.min(sig.runnerStop, be);
    }
    sig.realizedR = sig.runnerBankedR;
    sig.realizedRFull = sig.runnerBankedR;
    sig.fullPlanClosed = false;
    sig.resolveNote = `Bank ${bankFrac} @ ${plan.legs[0].rr}R (runner)`;
    return sig;
  }

  // Phase 2: trail / BE stop vs far target
  if (sig.outcomeTp1 === "WIN" && !sig.fullPlanClosed) {
    const stop = sig.runnerStop ?? sig.entry;
    const far =
      sig.runnerFarTarget ??
      plan.levels[plan.levels.length - 1] ??
      bankLevel;
    sig.runnerFarTarget = far;

    const winner = resolveGapAmongLevels(sig.side, open, high, low, [
      { kind: "TRAIL", level: stop },
      { kind: "TP2", level: far },
    ]);

    if (winner) {
      const rem = sig.runnerRemaining ?? 1 - bankFrac;
      const banked = sig.runnerBankedR ?? 0;
      if (winner.kind === "TRAIL") {
        const remR = rem * rAtPrice(sig.side, sig.entry, risk, stop);
        const total = Math.round((banked + remR) * 1000) / 1000;
        sig.slAfterTp1 = true;
        sig.slAfterTp1At = now;
        sig.realizedR = total;
        sig.realizedRFull = total;
        sig.fullPlanClosed = true;
        sig.resolvedAt = now;
        sig.resolveNote =
          Math.abs(stop - sig.entry) < 1e-6
            ? "BE stop after bank (runner)"
            : "Trail stop (runner)";
        return sig;
      }
      // Far target filled — bank remainder at target
      const remR = rem * rAtPrice(sig.side, sig.entry, risk, far);
      const total = Math.round((banked + remR) * 1000) / 1000;
      sig.tp2Hit = true;
      sig.tp2HitAt = now;
      sig.tp3Hit = true;
      sig.tp3HitAt = now;
      sig.realizedR = total;
      sig.realizedRFull = total;
      sig.fullPlanClosed = true;
      sig.resolvedAt = now;
      sig.resolveNote = "Far target (runner)";
      return sig;
    }

    // Update peak + tighten trail for subsequent bars
    const fav = favourableExtreme(sig.side, high, low);
    const prevPeak = sig.runnerPeak ?? sig.entry;
    sig.runnerPeak =
      sig.side === "BUY" ? Math.max(prevPeak, fav) : Math.min(prevPeak, fav);
    const nextTrail = trailStopFromPeak(
      sig.side,
      sig.entry,
      risk,
      sig.runnerPeak,
      trailPeakR,
    );
    const be = plan.stopAfter[0];
    sig.runnerStop =
      sig.side === "BUY"
        ? Math.max(stop, nextTrail, be)
        : Math.min(stop, nextTrail, be);
    return sig;
  }

  return null;
}

/**
 * Pure in-memory outcome advance (no DB). Used by live DB resolver and backtest.
 * `now` defaults to Date.now(); pass bar-close time in backtests.
 *
 * @param opts.exitPolicy
 *   - legacy (default): keep/compare — TP1 WIN, plan stays open for TP2/BE
 *   - fixed_tp1: bank 100% at plan TP1 and close
 *   - runner_trail_peak: trend runner (bank / BE / peak trail) inside this resolver
 */
export function advanceSignalOnBar(
  sig: LoggedSignal,
  tick: PriceTick,
  now: number = Date.now(),
  opts?: AdvanceBarOpts,
): LoggedSignal | null {
  const advancing = sig as AdvancingSignal;
  const policy: AdvanceExitPolicy =
    opts?.exitPolicy ?? advancing.exitPolicy ?? "legacy";
  advancing.exitPolicy = policy;

  if (policy === "fixed_tp1") return advanceFixedTp1(sig, tick, now);
  if (policy === "runner_trail_peak") {
    return advanceRunnerTrailPeak(advancing, tick, now);
  }
  // scale_be / runner_ladder / runner_trail not wired here — fall back to legacy
  return advanceLegacy(sig, tick, now);
}

/** Resolve / advance all active signals for a symbol with the latest tick. */
export function resolveOpenSignalsForSymbol(
  symbol: string,
  tick: PriceTick,
): LoggedSignal[] {
  const active = listActiveSignalsForSymbol(symbol);
  const updated: LoggedSignal[] = [];

  for (const sig of active) {
    const next = advanceSignalOnBar({ ...sig }, tick);
    if (!next) continue;
    updateSignal(next);
    if (sig.outcomeTp1 == null && next.outcomeTp1 != null) {
      noteLoggedSignalForLearn(next);
    }
    updated.push(next);
  }

  return updated;
}

/** Mark OPEN signal INVALIDATED (manual / plan cancelled). */
export function invalidateLoggedPlan(planKey: string, note = "Plan invalidated"): void {
  const sig = findByPlanKey(planKey);
  if (!sig) return;
  if (sig.outcome !== "OPEN" && !(sig.outcomeTp1 === "WIN" && !sig.fullPlanClosed)) {
    return;
  }
  // Only invalidate pre-TP1 opens for win-rate purity; post-TP1 keep WIN + close full plan at BE
  if (sig.outcome === "OPEN" && sig.outcomeTp1 == null) {
    sig.outcome = "INVALIDATED";
    sig.resolvedAt = Date.now();
    sig.realizedR = 0;
    sig.realizedRFull = 0;
    sig.fullPlanClosed = true;
    sig.resolveNote = note;
    updateSignal(sig);
    return;
  }
  if (sig.outcomeTp1 === "WIN" && !sig.fullPlanClosed) {
    sig.slAfterTp1 = true;
    sig.slAfterTp1At = Date.now();
    sig.fullPlanClosed = true;
    sig.realizedRFull = computeRealizedRFull(sig);
    sig.resolveNote = note;
    updateSignal(sig);
  }
}

export function listOpenSignals(): LoggedSignal[] {
  return listAllSignals().filter(
    (s) => s.outcome === "OPEN" || (s.outcomeTp1 === "WIN" && !s.fullPlanClosed),
  );
}

/**
 * Mark an OPEN (pre-TP1) plan as REGIME_FLIP_INVALIDATED — trend reversed against side.
 * wouldHaveHitSlFirst stays null; a later tick fills it via resolveRegimeFlipShadows.
 */
export function invalidateLoggedPlanRegimeFlip(planKey: string): void {
  const sig = findByPlanKey(planKey);
  if (!sig) return;
  if (sig.outcome !== "OPEN" || sig.outcomeTp1 != null) return;
  sig.outcome = "REGIME_FLIP_INVALIDATED";
  sig.resolvedAt = Date.now();
  sig.realizedR = 0;
  sig.realizedRFull = 0;
  sig.fullPlanClosed = true;
  sig.wouldHaveHitSlFirst = null;
  // Tier-1 ↔ Tier-2 link: did an earlier liquidity-sweep warning precede this flip?
  if (sig.liquiditySweepDetectedAt != null) {
    sig.liquiditySweepThenRegimeFlipped = true;
  }
  sig.resolveNote = "Regime flip vs plan side — invalidated before SL/TP";
  updateSignal(sig);
}

/**
 * Tier-1: record the first mid-plan liquidity-sweep warning on the open plan row.
 * Display/measurement only — does not resolve or alter the plan.
 */
export function markLiquiditySweep(planKey: string, at: number): void {
  const sig = findByPlanKey(planKey);
  if (!sig) return;
  if (sig.outcome !== "OPEN") return;
  if (sig.liquiditySweepDetectedAt != null) return;
  sig.liquiditySweepDetectedAt = at;
  updateSignal(sig);
}

/**
 * SCALPING-ONLY: stamp the row that was locked off a fresh trend-confirmation
 * trigger. Idempotent (first stamp wins).
 */
export function markTrendConfirmed(planKey: string, at: number): void {
  const sig = findByPlanKey(planKey);
  if (!sig) return;
  if (sig.trendConfirmedAt != null) return;
  sig.trendConfirmedAt = at;
  updateSignal(sig);
}

/**
 * Stamp when price first hits the locked entry zone (actual trade start).
 * Idempotent — first stamp wins. Used by History "EXECUTED" vs "NOT EXECUTED".
 */
export function markZoneTouched(planKey: string, at: number): void {
  const sig = findByPlanKey(planKey);
  if (!sig) return;
  if (sig.outcome !== "OPEN") return;
  if (sig.zoneTouchedAt != null) return;
  sig.zoneTouchedAt = at;
  updateSignal(sig);
}

/**
 * SCALPING-ONLY: record how many closed bars the confirmed trend lasted before it
 * reverted to RANGE / flipped. Only applies to trend-confirmed rows; first fill wins.
 */
export function setTrendDuration(planKey: string, bars: number): void {
  const sig = findByPlanKey(planKey);
  if (!sig) return;
  if (sig.trendConfirmedAt == null) return;
  if (sig.trendDurationBars != null) return;
  sig.trendDurationBars = bars;
  updateSignal(sig);
}

/**
 * Informational shadow: after a regime-flip invalidation, keep watching the
 * ORIGINAL SL vs TP1. First one touched sets wouldHaveHitSlFirst (true=SL, false=TP1).
 * This validates whether the flip trigger actually saved trades from losses.
 */
export function resolveRegimeFlipShadows(symbol: string, tick: PriceTick): LoggedSignal[] {
  const pending = listRegimeFlipPendingForSymbol(symbol);
  const updated: LoggedSignal[] = [];
  const { open, high, low } = barBounds(tick);

  for (const sig of pending) {
    const winner = resolveGapAmongLevels(sig.side, open, high, low, [
      { kind: "SL", level: sig.sl },
      { kind: "TP1", level: sig.tp1 },
    ]);
    if (!winner) continue;
    sig.wouldHaveHitSlFirst = winner.kind === "SL";
    updateSignal(sig);
    updated.push(sig);
  }

  return updated;
}
