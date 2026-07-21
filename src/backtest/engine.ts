import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AssetId,
  Candle,
  LiveSignal,
  RegimeTag,
  Side,
  TradeMode,
} from "../types";
import { ASSETS } from "../config/assets";
import { computeRegime, generateSignal } from "../strategies/signalEngine";
import { generateFractalSignal } from "../strategies/archived/fractalSignal";
import { makePlanKey } from "../calibration/db";
import { advanceSignalOnBar, resolveGapAmongLevels } from "../calibration/resolveOutcomes";
import type { LoggedSignal } from "../calibration/types";
import {
  createFrozenPlan,
  shouldKeepFrozenPlan,
  REGIME_FLIP_NOTE,
  type FrozenPlan,
} from "../services/tradePlan";
import {
  buildSessionExtras,
  canAutoLockPlan,
  sessionDayKey,
} from "../utils/sessionPlan";
import { isTooLateToEnter } from "../utils/tradeSafety";
import { isLiquiditySweepAgainst } from "../utils/liquidityWarning";
import {
  evaluateTrendConfirm,
  markTrendConsumed,
  newTrendTracker,
  type TrendTracker,
} from "../utils/trendConfirm";
import {
  framesAtIndex,
  isClosedFifteenEnd,
  precomputeHtfs,
  type FrameBundle,
} from "./frames";
import {
  insertBacktestSignal,
  setBacktestTrendDuration,
  updateBacktestSignal,
} from "./store";

/** Optional module adapter — measurement harness only; does not alter strategy code. */
export type SessionLockCandidateFn = (
  frames: FrameBundle,
  mode: TradeMode,
  assetId: AssetId,
) => LiveSignal | null;

export interface BacktestOptions {
  assetId: AssetId;
  modes: TradeMode[];
  /** Price units (Gold $). BUY entry += spread, SELL entry -= spread. */
  spread: number;
  /** First M5 index inside the reported window (warmup bars before this exist). */
  windowStartIdx: number;
  /** SCALPING-ONLY trend-confirmation M (consecutive confirm bars). Default 4. */
  trendConfirmBars?: number;
  /**
   * When true, only auto-lock if Bill Williams fractal breakout direction
   * agrees with generateSignal side (lean TTrades gate — no quality stack).
   * Default false = main desk baseline path unchanged.
   */
  requireFractalAgree?: boolean;
  /**
   * When set, replaces the IDLE `generateSignal` candidate (session-lock /
   * zone-touch / SL-priority resolution stay identical). Used only for
   * apples-to-apples module measurement — not a live behavior change.
   */
  signalCandidate?: SessionLockCandidateFn;
  /**
   * Mirror live alertBot lockPlan: refuse a new lock when the move is already
   * 0.5R toward target (reject-already-missed). Default false = baseline engine.
   */
  rejectAlreadyMissed?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface RegimeFunnelBucket {
  locked: number;
  touched: number;
  tp1Wins: number;
  tp1Losses: number;
}

export interface BacktestStats {
  /** Plans locked (funnel stage 1 — live “plan lock” alert). */
  signalsFired: number;
  /** Locked plans whose entry zone was touched (funnel stage 2). */
  zoneTouched: number;
  /** Among touched plans that resolved TP1 WIN/LOSS. */
  tp1WinsAfterTouch: number;
  tp1LossesAfterTouch: number;
  /** Plans dropped mid-session because regime flipped against side. */
  regimeFlips: number;
  /** Of those, shadow shows price would have hit SL first (flip saved a loss). */
  regimeFlipWouldHitSl: number;
  /** Of those, price would have hit TP1 first (flip cancelled a would-be win). */
  regimeFlipWouldHitTp1: number;
  /** Of those, neither level reached before end of data (undetermined). */
  regimeFlipUnknown: number;
  /** SCALPING-ONLY: fresh trend-confirmation triggers fired (once per trend run). */
  trendConfirmations: number;
  /** SCALPING-ONLY: plans locked off a fresh trend-confirmation trigger. */
  trendConfirmedLocks: number;
  /** Scalping TP1 outcomes for trend-confirmed vs non-confirmed locks. */
  trendConfirmedTp1Wins: number;
  trendConfirmedTp1Losses: number;
  nonTrendTp1Wins: number;
  nonTrendTp1Losses: number;
  /** Bars each confirmed trend lasted before reverting to RANGE / flipping. */
  trendDurations: number[];
  byMonth: Map<string, number>;
  byRegime: Map<string, RegimeFunnelBucket>;
  equityR: number[];
}

type Phase = "IDLE" | "PLAN_LOCKED" | "ENTRY_HIT";

type ModeState = {
  phase: Phase;
  /** Live FrozenPlan mirror — kept after invalidate until session allows re-lock. */
  plan: FrozenPlan | null;
  row: LoggedSignal | null;
};

function emptyRegime(): RegimeFunnelBucket {
  return { locked: 0, touched: 0, tp1Wins: 0, tp1Losses: 0 };
}

function bumpRegime(
  map: Map<string, RegimeFunnelBucket>,
  regime: RegimeTag | null | undefined,
  field: keyof RegimeFunnelBucket,
) {
  const key = regime ?? "UNKNOWN";
  const b = map.get(key) ?? emptyRegime();
  b[field] += 1;
  map.set(key, b);
}

function applySpread(
  side: "BUY" | "SELL",
  entry: number,
  spread: number,
): number {
  if (spread <= 0) return entry;
  return side === "BUY" ? entry + spread : entry - spread;
}

function toLogged(
  signal: ReturnType<typeof generateSignal>,
  entry: number,
  ts: number,
): LoggedSignal | null {
  if (signal.side !== "BUY" && signal.side !== "SELL") return null;
  if (!signal.levels) return null;
  const d = signal.diagnostics;
  const planKey = makePlanKey(
    signal.asset,
    signal.mode,
    signal.side,
    entry,
    signal.levels.stopLoss,
    signal.levels.takeProfit1,
  );
  return {
    id: randomUUID(),
    timestamp: ts,
    symbol: signal.asset,
    mode: signal.mode,
    side: signal.side,
    entry,
    sl: signal.levels.stopLoss,
    tp1: signal.levels.takeProfit1,
    tp2: signal.levels.takeProfit2,
    tp3: signal.levels.takeProfit3,
    confidence: signal.confidence,
    winChanceDisplayed: signal.rangePrediction.winProbability,
    winChanceCalibrated: null,
    confluencePct: d.confluencePct,
    smcScore: d.smcScore,
    maScore: d.maScore,
    paScore: d.paScore,
    bullPts: d.bullPts,
    bearPts: d.bearPts,
    htfAligned: d.htfAligned,
    dailyBias: signal.dailyBias.bias,
    conflictingSignals: d.conflictingSignals,
    conflictCapped: d.conflictCapped,
    planKey,
    outcome: "OPEN",
    outcomeTp1: null,
    resolvedAt: null,
    realizedR: null,
    realizedRFull: null,
    fullPlanClosed: false,
    tp2Hit: false,
    tp3Hit: false,
    slAfterTp1: false,
    tp1HitAt: null,
    tp2HitAt: null,
    tp3HitAt: null,
    slAfterTp1At: null,
    atr14: d.atr14,
    atrPctOfPrice: d.atrPctOfPrice,
    regime: d.regime,
    resolveNote: "PLAN_LOCKED",
    zoneTouchedAt: null,
    wouldHaveHitSlFirst: null,
    liquiditySweepDetectedAt: null,
    liquiditySweepThenRegimeFlipped: null,
  };
}

function monthKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

/**
 * Informational shadow (backtest has future data live does not): had the plan
 * NOT been invalidated, would the ORIGINAL SL be hit before TP1 from here on?
 * true = flip saved a loss; false = flip cancelled a would-be win; null = neither.
 */
function shadowWouldHitSlFirst(
  m5: Candle[],
  fromIdx: number,
  side: "BUY" | "SELL",
  sl: number,
  tp1: number,
): boolean | null {
  for (let j = fromIdx; j < m5.length; j++) {
    const b = m5[j];
    const winner = resolveGapAmongLevels(side, b.open, b.high, b.low, [
      { kind: "SL", level: sl },
      { kind: "TP1", level: tp1 },
    ]);
    if (winner) return winner.kind === "SL";
  }
  return null;
}

/** Mirror live nowAction entry-zone hit using frozen zone bounds. */
function barTouchesZone(
  bar: Candle,
  zoneLow: number | undefined,
  zoneHigh: number | undefined,
  entry: number,
): boolean {
  const low = zoneLow ?? entry;
  const high = zoneHigh ?? entry;
  const zLo = Math.min(low, high);
  const zHi = Math.max(low, high);
  return bar.low <= zHi && bar.high >= zLo;
}

function idleAfterResolve(mode: TradeMode, plan: FrozenPlan): ModeState {
  if (mode === "intraday" && plan.sessionDate) {
    return {
      phase: "IDLE",
      plan: {
        ...plan,
        status: "INVALIDATED",
        note: "Session plan resolved — no auto re-lock until next UTC day",
      },
      row: null,
    };
  }
  return { phase: "IDLE", plan: null, row: null };
}

function invalidateWaiting(
  db: Database.Database,
  state: ModeState,
  asOfClose: number,
  note: string,
): ModeState {
  const { row, plan } = state;
  if (row) {
    row.outcome = "INVALIDATED";
    row.resolvedAt = asOfClose;
    row.realizedR = 0;
    row.realizedRFull = 0;
    row.fullPlanClosed = true;
    row.resolveNote = note;
    updateBacktestSignal(db, row);
  }
  if (!plan) return { phase: "IDLE", plan: null, row: null };
  const dead: FrozenPlan = {
    ...plan,
    status: "INVALIDATED",
    note,
  };
  // Intraday: keep invalidated plan so canAutoLockPlan blocks same UTC day.
  if (plan.mode === "intraday" && plan.sessionDate) {
    return { phase: "IDLE", plan: dead, row: null };
  }
  return { phase: "IDLE", plan: null, row: null };
}

/**
 * Walk-forward backtest mirroring live session-lock state machine
 * (canAutoLockPlan / createFrozenPlan / sessionDayKey / shouldKeepFrozenPlan).
 * One FrozenPlan per mode. generateSignal only when IDLE.
 */
export function runWalkForward(
  db: Database.Database,
  m5: Candle[],
  opts: BacktestOptions,
): BacktestStats {
  const byMode = new Map<TradeMode, ModeState>();
  for (const mode of opts.modes) {
    byMode.set(mode, { phase: "IDLE", plan: null, row: null });
  }

  const stats: BacktestStats = {
    signalsFired: 0,
    zoneTouched: 0,
    tp1WinsAfterTouch: 0,
    tp1LossesAfterTouch: 0,
    regimeFlips: 0,
    regimeFlipWouldHitSl: 0,
    regimeFlipWouldHitTp1: 0,
    regimeFlipUnknown: 0,
    trendConfirmations: 0,
    trendConfirmedLocks: 0,
    trendConfirmedTp1Wins: 0,
    trendConfirmedTp1Losses: 0,
    nonTrendTp1Wins: 0,
    nonTrendTp1Losses: 0,
    trendDurations: [],
    byMonth: new Map(),
    byRegime: new Map(),
    equityR: [],
  };

  let equity = 0;
  const total = m5.length;
  const htfs = precomputeHtfs(m5);

  // SCALPING-ONLY trend-confirmation trigger state (per mode, though only scalping
  // is ever populated). Intraday never touches these.
  const trendConfirmBars = opts.trendConfirmBars ?? undefined; // undefined → default M
  const trendTrackers = new Map<TradeMode, TrendTracker>();
  // Per confirmation EVENT (not per lock): track its trend-run duration; attach the
  // duration to the tagged lock row (if any) once the trend ends.
  const trendEventRuns = new Map<
    TradeMode,
    { dir: Side; confirmIndex: number; row: LoggedSignal | null }
  >();
  for (const mode of opts.modes) {
    if (mode === "scalping") trendTrackers.set(mode, newTrendTracker());
  }

  for (let i = 0; i < m5.length; i++) {
    const bar = m5[i];
    const periodMs =
      i + 1 < m5.length ? m5[i + 1].time - bar.time : 5 * 60 * 1000;
    const asOfClose = bar.time + periodMs;
    const asOf = new Date(asOfClose);
    const today = sessionDayKey(asOf);
    const tick = {
      price: bar.close,
      open: bar.open,
      high: bar.high,
      low: bar.low,
    };

    // Regime-flip invalidation: log REGIME_FLIP_INVALIDATED + shadow verdict,
    // drop the plan, return to IDLE (immediate re-lock allowed next bar).
    const flipInvalidate = (st: ModeState): ModeState => {
      const row = st.row;
      if (row) {
        row.outcome = "REGIME_FLIP_INVALIDATED";
        row.resolvedAt = asOfClose;
        row.realizedR = 0;
        row.realizedRFull = 0;
        row.fullPlanClosed = true;
        row.wouldHaveHitSlFirst = shadowWouldHitSlFirst(
          m5,
          i,
          row.side,
          row.sl,
          row.tp1,
        );
        if (row.liquiditySweepDetectedAt != null) {
          row.liquiditySweepThenRegimeFlipped = true;
        }
        row.resolveNote = "Regime flip vs plan side — invalidated";
        updateBacktestSignal(db, row);
        stats.regimeFlips += 1;
        if (row.wouldHaveHitSlFirst === true) stats.regimeFlipWouldHitSl += 1;
        else if (row.wouldHaveHitSlFirst === false) stats.regimeFlipWouldHitTp1 += 1;
        else stats.regimeFlipUnknown += 1;
      }
      return { phase: "IDLE", plan: null, row: null };
    };

    for (const mode of opts.modes) {
      let state = byMode.get(mode)!;

      // ── Session rollover (same UTC day key as live) ──────────────────────
      if (
        mode === "intraday" &&
        state.plan?.sessionDate &&
        state.plan.sessionDate !== today
      ) {
        if (state.phase === "PLAN_LOCKED" && state.row) {
          state = invalidateWaiting(
            db,
            state,
            asOfClose,
            `Session rollover ${state.plan.sessionDate}→${today} — zone never touched`,
          );
          // Clear spent plan so new day can lock (sessionDate !== today already,
          // but null is cleaner IDLE for the new session).
          state = { phase: "IDLE", plan: null, row: null };
        } else if (state.phase === "IDLE") {
          // Prior-day INVALIDATED marker — drop so today can auto-lock.
          state = { phase: "IDLE", plan: null, row: null };
        }
        // ENTRY_HIT: keep managing open trade across day boundary (live does).
        byMode.set(mode, state);
      }

      // Recompute regime on the current closed bar (same classifier as logged)
      // only while a plan is active — IDLE re-derives it inside generateSignal.
      const frames =
        i >= opts.windowStartIdx ? framesAtIndex(m5, i, mode, htfs) : null;
      const activeNow = state.phase !== "IDLE";
      const barRegime = frames && activeNow ? computeRegime(frames.primary) : null;
      // Gate 2: HTF regimes on the higher-TF series (same computeRegime).
      const htfRegimes: (RegimeTag | null)[] =
        frames && activeNow
          ? [
              frames.confirmation.length ? computeRegime(frames.confirmation) : null,
              frames.bias.length ? computeRegime(frames.bias) : null,
            ]
          : [];
      // Tier-1 (log only): liquidity sweep against the active plan side.
      const sweepAgainst =
        frames && activeNow && state.plan
          ? isLiquiditySweepAgainst(state.plan.side, frames.primary)
          : false;

      // ── SCALPING-ONLY: trend-confirmation trigger (fresh trend start) ─────
      // Runs every closed bar (any phase) so transitions + trend duration are
      // tracked. Intraday is untouched.
      let trendArmedThisBar = false;
      let trendDirThisBar: Side = "WAIT";
      if (mode === "scalping" && frames) {
        const scRegime = computeRegime(frames.primary);
        const scHtf: (RegimeTag | null)[] = [
          frames.confirmation.length ? computeRegime(frames.confirmation) : null,
          frames.bias.length ? computeRegime(frames.bias) : null,
        ];
        const tracker = trendTrackers.get(mode)!;
        const res = evaluateTrendConfirm(
          tracker,
          scRegime,
          frames.primary,
          scHtf,
          bar.time,
          trendConfirmBars,
        );
        trendArmedThisBar = res.armed;
        trendDirThisBar = res.dir;

        // Finalize the previous event's trend-run duration when it reverts / flips,
        // BEFORE possibly starting a new event this bar.
        const run = trendEventRuns.get(mode);
        if (run) {
          const stillTrending =
            (run.dir === "BUY" && scRegime === "TREND_UP") ||
            (run.dir === "SELL" && scRegime === "TREND_DOWN");
          if (!stillTrending) {
            const dur = i - run.confirmIndex;
            stats.trendDurations.push(dur);
            if (run.row) setBacktestTrendDuration(db, run.row.id, dur);
            trendEventRuns.delete(mode);
          }
        }

        // New confirmation event fired this bar → count it + start a duration run
        // (independent of whether a trade is taken).
        if (res.newEvent) {
          stats.trendConfirmations += 1;
          trendEventRuns.set(mode, {
            dir: res.dir,
            confirmIndex: i,
            row: null,
          });
        }
      }

      // ── Advance locked / in-trade plans (frozen levels — no generateSignal) ─
      if (state.phase === "PLAN_LOCKED" && state.plan && state.row) {
        const row = state.row;

        const kept = shouldKeepFrozenPlan(
          state.plan,
          state.plan.side,
          bar.close,
          barRegime,
          htfRegimes,
        );
        if (kept?.status === "INVALIDATED") {
          state =
            kept.note === REGIME_FLIP_NOTE
              ? flipInvalidate(state)
              : invalidateWaiting(
                  db,
                  { ...state, plan: kept },
                  asOfClose,
                  kept.note || "Plan invalidated before zone touch",
                );
          byMode.set(mode, state);
          continue;
        }
        // Persist rolling flip-confirmation counter for next bar.
        const plan = kept ?? state.plan;
        state = { ...state, plan };

        // Tier-1: record first liquidity-sweep warning while waiting for entry.
        if (sweepAgainst && row.liquiditySweepDetectedAt == null) {
          row.liquiditySweepDetectedAt = asOfClose;
          updateBacktestSignal(db, row);
        }

        if (
          barTouchesZone(
            bar,
            plan.entryZoneLow,
            plan.entryZoneHigh,
            plan.levels.entry,
          )
        ) {
          row.zoneTouchedAt = asOfClose;
          row.resolveNote = "ENTRY_HIT";
          updateBacktestSignal(db, row);
          stats.zoneTouched += 1;
          bumpRegime(stats.byRegime, row.regime, "touched");

          const activePlan: FrozenPlan = {
            ...plan,
            status: "IN_TRADE_HINT",
            note: `Entry zone hit @ ${asOfClose}`,
          };
          const next = advanceSignalOnBar({ ...row }, tick, asOfClose);
          if (next) {
            updateBacktestSignal(db, next);
            if (next.outcomeTp1 === "WIN" || next.outcomeTp1 === "LOSS") {
              if (next.outcomeTp1 === "WIN") {
                stats.tp1WinsAfterTouch += 1;
                bumpRegime(stats.byRegime, next.regime, "tp1Wins");
              } else {
                stats.tp1LossesAfterTouch += 1;
                bumpRegime(stats.byRegime, next.regime, "tp1Losses");
              }
            }
            if (next.outcomeTp1 === "LOSS" || next.fullPlanClosed) {
              const r = next.realizedRFull ?? next.realizedR ?? 0;
              equity += r;
              stats.equityR.push(equity);
              state = idleAfterResolve(mode, activePlan);
            } else {
              state = { phase: "ENTRY_HIT", plan: activePlan, row: next };
            }
          } else {
            state = { phase: "ENTRY_HIT", plan: activePlan, row };
          }
          byMode.set(mode, state);
          continue;
        }

        byMode.set(mode, state);
        continue;
      }

      if (state.phase === "ENTRY_HIT" && state.plan && state.row) {
        // Regime flip on an active trade → exit early (mirror PLAN_LOCKED rule).
        const keptActive = shouldKeepFrozenPlan(
          state.plan,
          state.plan.side,
          bar.close,
          barRegime,
          htfRegimes,
        );
        if (
          keptActive?.status === "INVALIDATED" &&
          keptActive.note === REGIME_FLIP_NOTE &&
          state.row.outcome === "OPEN" &&
          state.row.outcomeTp1 == null
        ) {
          state = flipInvalidate(state);
          byMode.set(mode, state);
          continue;
        }
        // Persist rolling flip-confirmation counter for next bar (keep IN_TRADE status).
        if (keptActive) {
          state = {
            ...state,
            plan: { ...state.plan, flipStreak: keptActive.flipStreak },
          };
        }

        // Tier-1: record first liquidity-sweep warning during the active trade.
        if (sweepAgainst && state.row.liquiditySweepDetectedAt == null) {
          state.row.liquiditySweepDetectedAt = asOfClose;
          updateBacktestSignal(db, state.row);
        }

        const next = advanceSignalOnBar({ ...state.row }, tick, asOfClose);
        if (next) {
          updateBacktestSignal(db, next);
          if (next.outcomeTp1 === "WIN" || next.outcomeTp1 === "LOSS") {
            // Count TP1 only once (first time outcomeTp1 appears)
            if (state.row.outcomeTp1 == null) {
              const confirmed =
                next.mode === "scalping" && next.trendConfirmedAt != null;
              if (next.outcomeTp1 === "WIN") {
                stats.tp1WinsAfterTouch += 1;
                bumpRegime(stats.byRegime, next.regime, "tp1Wins");
                if (next.mode === "scalping") {
                  if (confirmed) stats.trendConfirmedTp1Wins += 1;
                  else stats.nonTrendTp1Wins += 1;
                }
              } else {
                stats.tp1LossesAfterTouch += 1;
                bumpRegime(stats.byRegime, next.regime, "tp1Losses");
                if (next.mode === "scalping") {
                  if (confirmed) stats.trendConfirmedTp1Losses += 1;
                  else stats.nonTrendTp1Losses += 1;
                }
              }
            }
          }
          if (next.outcomeTp1 === "LOSS" || next.fullPlanClosed) {
            const r = next.realizedRFull ?? next.realizedR ?? 0;
            equity += r;
            stats.equityR.push(equity);
            state = idleAfterResolve(mode, state.plan);
          } else {
            state = { phase: "ENTRY_HIT", plan: state.plan, row: next };
          }
        }
        byMode.set(mode, state);
        continue;
      }

      // ── IDLE: only then attempt generateSignal + canAutoLockPlan ───────────
      if (state.phase !== "IDLE") {
        byMode.set(mode, state);
        continue;
      }

      if (i < opts.windowStartIdx) {
        byMode.set(mode, state);
        continue;
      }

      if (mode === "intraday" && !isClosedFifteenEnd(m5, i)) {
        byMode.set(mode, state);
        continue;
      }

      if (!frames) {
        byMode.set(mode, state);
        continue;
      }

      const signal = opts.signalCandidate
        ? opts.signalCandidate(frames, mode, opts.assetId)
        : generateSignal(opts.assetId, mode, frames);
      if (
        !signal ||
        !canAutoLockPlan(mode, signal, state.plan, opts.assetId, asOf)
      ) {
        byMode.set(mode, state);
        continue;
      }

      if (
        opts.rejectAlreadyMissed &&
        signal.levels &&
        (signal.side === "BUY" || signal.side === "SELL") &&
        isTooLateToEnter(
          signal.side,
          bar.close,
          signal.levels.entry,
          signal.levels.stopLoss,
        )
      ) {
        byMode.set(mode, state);
        continue;
      }

      if (opts.requireFractalAgree) {
        const fr = generateFractalSignal({ candles: frames.primary });
        if (
          !fr ||
          (signal.side !== "BUY" && signal.side !== "SELL") ||
          fr.direction !== signal.side
        ) {
          byMode.set(mode, state);
          continue;
        }
      }

      const extras = buildSessionExtras(
        opts.assetId,
        mode,
        signal.side,
        signal.levels!,
        signal,
        asOf,
      );
      const plan = createFrozenPlan(
        opts.assetId,
        mode,
        signal.side,
        signal.levels!,
        signal.confidence,
        signal.rangePrediction.winProbability,
        extras,
        asOfClose,
      );
      if (plan.status === "INVALIDATED" || plan.side === "WAIT") {
        byMode.set(mode, state);
        continue;
      }

      const entry = applySpread(signal.side, plan.levels.entry, opts.spread);
      const row = toLogged(
        {
          ...signal,
          side: plan.side,
          levels: plan.levels,
          confidence: plan.lockedConfidence ?? signal.confidence,
        },
        entry,
        asOfClose,
      );
      if (!row) {
        byMode.set(mode, state);
        continue;
      }

      // SCALPING-ONLY: tag this lock as trend-confirmed when the fresh-trend
      // trigger fired this bar in the same direction as the locked plan.
      if (
        mode === "scalping" &&
        trendArmedThisBar &&
        row.side === trendDirThisBar
      ) {
        row.trendConfirmedAt = asOfClose;
        plan.trendConfirmed = true;
        plan.trendConfirmedAt = asOfClose;
        stats.trendConfirmedLocks += 1;
        markTrendConsumed(trendTrackers.get(mode)!);
        // Attach this lock to the current event run so it inherits trendDurationBars.
        const run = trendEventRuns.get(mode);
        if (run && run.row == null) run.row = row;
      }

      insertBacktestSignal(db, row);
      state = { phase: "PLAN_LOCKED", plan, row };
      stats.signalsFired += 1;
      bumpRegime(stats.byRegime, row.regime, "locked");
      const mk = monthKey(asOfClose);
      stats.byMonth.set(mk, (stats.byMonth.get(mk) ?? 0) + 1);
      byMode.set(mode, state);
    }

    if (i % 2000 === 0) opts.onProgress?.(i, total);
  }

  // End-of-data: invalidate still-waiting locks
  const last = m5[m5.length - 1];
  const lastClose =
    last.time +
    (m5.length > 1 ? m5[m5.length - 1].time - m5[m5.length - 2].time : 5 * 60 * 1000);
  for (const mode of opts.modes) {
    const state = byMode.get(mode)!;
    if (state.phase === "PLAN_LOCKED" && state.row) {
      invalidateWaiting(
        db,
        state,
        lastClose,
        "End of data — zone never touched",
      );
    }
  }

  // Finalize any still-running confirmation-event duration counters.
  for (const [mode, run] of trendEventRuns) {
    if (mode !== "scalping") continue;
    const dur = m5.length - 1 - run.confirmIndex;
    stats.trendDurations.push(dur);
    if (run.row) setBacktestTrendDuration(db, run.row.id, dur);
  }

  opts.onProgress?.(total, total);
  return stats;
}

/** Max drawdown in R from equity curve (cumulative realizedRFull). */
export function maxDrawdownR(equityCurve: number[]): number {
  if (equityCurve.length === 0) return 0;
  let peak = equityCurve[0];
  let maxDd = 0;
  for (const e of equityCurve) {
    if (e > peak) peak = e;
    const dd = peak - e;
    if (dd > maxDd) maxDd = dd;
  }
  return Math.round(maxDd * 1000) / 1000;
}

/** Longest consecutive TP1 LOSS streak (touched plans only). */
export function longestLosingStreak(signals: LoggedSignal[]): number {
  let best = 0;
  let cur = 0;
  const resolved = signals
    .filter(
      (s) =>
        s.zoneTouchedAt != null &&
        (s.outcomeTp1 === "WIN" || s.outcomeTp1 === "LOSS"),
    )
    .sort((a, b) => (a.resolvedAt ?? a.timestamp) - (b.resolvedAt ?? b.timestamp));
  for (const s of resolved) {
    if (s.outcomeTp1 === "LOSS") {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

export function zoneTouchRate(stats: BacktestStats): number | null {
  if (stats.signalsFired <= 0) return null;
  return (stats.zoneTouched / stats.signalsFired) * 100;
}

export function conditionalTp1WinRate(stats: BacktestStats): number | null {
  const n = stats.tp1WinsAfterTouch + stats.tp1LossesAfterTouch;
  if (n <= 0) return null;
  return (stats.tp1WinsAfterTouch / n) * 100;
}
