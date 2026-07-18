import {
  listActiveSignalsForSymbol,
  listAllSignals,
  listRegimeFlipPendingForSymbol,
  updateSignal,
  findByPlanKey,
} from "./db";
import { computeRealizedRFull, realizedRAtExit } from "./realizedR";
import type { LoggedSignal, SignalOutcome } from "./types";

export interface PriceTick {
  price: number;
  /** Optional bar context for gap resolution */
  open?: number;
  high?: number;
  low?: number;
}

type LevelKind = "SL" | "TP1" | "TP2" | "TP3" | "BE_SL";

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
  const isStop = kind === "SL" || kind === "BE_SL";
  if (side === "BUY") {
    return isStop ? low <= level : high >= level;
  }
  return isStop ? high >= level : low <= level;
}

/**
 * Worst-case gap resolution when multiple levels lie inside the bar range.
 * Prefer the level closer to `open`; ties / ambiguity → SL / BE_SL (never optimistic TP).
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
    const aSl = a.kind === "SL" || a.kind === "BE_SL" ? 0 : 1;
    const bSl = b.kind === "SL" || b.kind === "BE_SL" ? 0 : 1;
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

  // TP1 first → primary WIN; continue tracking TP2/TP3 vs BE stop
  sig.outcome = "TP1_HIT";
  sig.outcomeTp1 = "WIN";
  sig.resolvedAt = now;
  sig.tp1HitAt = now;
  sig.realizedR =
    Math.round(realizedRAtExit(sig.side, sig.entry, sig.sl, sig.tp1) * 1000) / 1000;
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

/**
 * Pure in-memory outcome advance (no DB). Used by live DB resolver and backtest.
 * `now` defaults to Date.now(); pass bar-close time in backtests.
 */
export function advanceSignalOnBar(
  sig: LoggedSignal,
  tick: PriceTick,
  now: number = Date.now(),
): LoggedSignal | null {
  const { open, high, low } = barBounds(tick);

  // Phase 1: waiting for TP1 vs original SL
  if (sig.outcome === "OPEN" && sig.outcomeTp1 == null) {
    const winner = resolveGapAmongLevels(sig.side, open, high, low, [
      { kind: "SL", level: sig.sl },
      { kind: "TP1", level: sig.tp1 },
    ]);
    if (!winner) return null;
    const note =
      winner.kind === "SL"
        ? "SL before TP1 (gap/tick)"
        : "TP1 before SL (gap/tick)";
    return applyTp1Resolution(sig, winner, now, note);
  }

  // Phase 2: after TP1 WIN — track TP2/TP3 vs breakeven (entry)
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
  sig.resolveNote = "Regime flip vs plan side — invalidated before SL/TP";
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
