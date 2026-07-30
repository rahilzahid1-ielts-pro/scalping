/**
 * Demo account engine — open / close / price-resolve / history sync.
 * Risk sized from *starting* balance × riskPct (not current balance).
 * Open trades / low balance never block new setups — test every signal.
 *
 * Exit policy: fixed_tp1 for all modules. QS Pro runner_trail_peak archived
 * (ENABLE_DEMO_RUNNER_EXIT default 0; opt-in =1 for research only).
 */
import {
  advanceRunnerOnPrice,
  buildExitPlan,
  DEFAULT_RUNNER_TUNE,
  liveExitPolicy,
  rAtPrice,
  type ExitPlan,
  type ExitPolicyId,
  type RunnerState,
} from "../exits/exitPolicy";
import {
  applyPnlToBalance,
  closeDemoPositionInDb,
  DEMO_ACCOUNT_ID,
  DEMO_STARTING_BALANCE,
  ensureDemoAccount,
  findDemoBySourceId,
  insertDemoPosition,
  listDemoPositions,
  listOpenDemoPositions,
  rewriteClosedDemoPosition,
  updateDemoRunnerState,
  type DemoAccountRow,
  type DemoOutcome,
  type DemoPositionRow,
} from "./store";

export type TakeTradeInput = {
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2?: number | null;
  module: string;
  sourceId?: string | null;
  note?: string;
  /** Force risk $ (otherwise riskPct of starting balance). */
  riskUsd?: number;
  /** Signal regime — trend regimes get the runner ladder. */
  regime?: string | null;
};

const money2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Exit plan for a position. Rows opened before the runner shipped have no
 * `policy`, so they keep finishing under the rules they were opened with.
 * For fixed_tp1, prefer the stored TP1 so SL:TP distance stays 1:1 (or
 * whatever the desk set) instead of a hard-coded 0.85R bank.
 */
export function planForPosition(pos: DemoPositionRow): ExitPlan {
  const policy = (pos.policy as ExitPolicyId | null) ?? "fixed_tp1";
  const base = buildExitPlan({
    policy,
    side: pos.side,
    entry: pos.entry,
    sl: pos.sl,
    regime: pos.regime,
    tune: DEFAULT_RUNNER_TUNE,
  });
  if (policy !== "fixed_tp1") return base;
  const risk = Math.abs(pos.entry - pos.sl);
  if (!(risk > 0) || !Number.isFinite(pos.tp1)) return base;
  const rr = Math.abs(pos.tp1 - pos.entry) / risk;
  if (!(rr > 0) || !Number.isFinite(rr)) return base;
  return {
    ...base,
    legs: [{ fraction: 1, rr, label: "TP1" }],
    levels: [pos.tp1],
  };
}

export function runnerStateOf(pos: DemoPositionRow): RunnerState {
  return {
    filled: pos.partsClosed,
    bankedR: pos.bankedR,
    stop: pos.stopNow ?? pos.sl,
    peakPrice: pos.peakPrice ?? pos.entry,
  };
}

export type TakeTradeResult =
  | { ok: true; position: DemoPositionRow; account: DemoAccountRow }
  | { ok: false; error: string };

function riskDistance(entry: number, sl: number): number {
  return Math.abs(entry - sl);
}

/** R from price move vs SL distance (positive = in favor of side). */
export function unrealizedR(
  side: "BUY" | "SELL",
  entry: number,
  sl: number,
  live: number,
): number | null {
  const risk = riskDistance(entry, sl);
  if (!(risk > 0) || !Number.isFinite(live)) return null;
  if (side === "BUY") return (live - entry) / risk;
  return (entry - live) / risk;
}

export function rFromLevels(
  _side: "BUY" | "SELL",
  entry: number,
  sl: number,
  tp1: number,
): number {
  const risk = riskDistance(entry, sl);
  if (!(risk > 0)) return 1;
  const reward = Math.abs(tp1 - entry);
  return Math.round((reward / risk) * 1000) / 1000;
}

export function takeDemoTrade(input: TakeTradeInput): TakeTradeResult {
  const acct = ensureDemoAccount();

  const risk = riskDistance(input.entry, input.sl);
  if (!(risk > 0)) {
    return { ok: false, error: "Invalid SL distance" };
  }
  if (input.side !== "BUY" && input.side !== "SELL") {
    return { ok: false, error: "Side must be BUY or SELL" };
  }

  if (input.sourceId) {
    const existing = findDemoBySourceId(input.sourceId);
    if (existing) {
      return { ok: false, error: "Ye trade pehle se demo account me hai" };
    }
  }

  // Always size from starting bank ($2000) — never gate on live balance or open count.
  const bank =
    acct.startingBalance > 0 ? acct.startingBalance : DEMO_STARTING_BALANCE;
  const riskUsd =
    input.riskUsd != null && input.riskUsd > 0
      ? Math.round(input.riskUsd * 100) / 100
      : Math.round(((bank * acct.riskPct) / 100) * 100) / 100;

  if (!(riskUsd > 0)) {
    return { ok: false, error: "Risk $ too small" };
  }

  const now = Date.now();
  const position: DemoPositionRow = {
    id: `demo-${now}-${input.side}-${input.entry}`,
    accountId: DEMO_ACCOUNT_ID,
    sourceId: input.sourceId ?? null,
    module: input.module || "manual",
    side: input.side,
    entry: input.entry,
    sl: input.sl,
    tp1: input.tp1,
    tp2: input.tp2 ?? null,
    riskUsd,
    status: "OPEN",
    outcome: "OPEN",
    realizedR: null,
    pnlUsd: null,
    openedAt: now,
    closedAt: null,
    note:
      input.note ||
      `${input.side} @ ${input.entry} · risk $${riskUsd} (${acct.riskPct}% of start $${bank})`,
    regime: input.regime ?? null,
    policy: liveExitPolicy(input.module),
    stopNow: input.sl,
    partsClosed: 0,
    bankedR: 0,
    bankedUsd: 0,
    peakPrice: input.entry,
  };

  try {
    insertDemoPosition(position);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE/i.test(msg)) {
      return { ok: false, error: "Duplicate source trade" };
    }
    return { ok: false, error: msg };
  }

  return { ok: true, position, account: ensureDemoAccount() };
}

export function closeDemoTrade(
  positionId: string,
  opts: {
    outcome: DemoOutcome;
    realizedR?: number | null;
    note?: string;
  },
): TakeTradeResult {
  const opens = listOpenDemoPositions();
  const pos = opens.find((p) => p.id === positionId);
  if (!pos) {
    return { ok: false, error: "OPEN position nahi mili" };
  }

  let r = opts.realizedR;
  if (r == null || !Number.isFinite(r)) {
    if (pos.partsClosed > 0) {
      // A runner already banked legs and credited them to the balance. Settle
      // the untouched remainder at the stop it had ratcheted to — never below
      // what the position had already locked in.
      const plan = planForPosition(pos);
      const remainder = Math.max(
        0,
        1 - plan.legs.slice(0, pos.partsClosed).reduce((a, l) => a + l.fraction, 0),
      );
      const stop = pos.stopNow ?? pos.sl;
      r =
        pos.bankedR +
        remainder * rAtPrice(pos.side, pos.entry, plan.risk, stop);
    } else if (opts.outcome === "SL_HIT") r = -1;
    else if (opts.outcome === "TP1_HIT" || opts.outcome === "TP2_HIT") {
      r = rFromLevels(pos.side, pos.entry, pos.sl, pos.tp1);
      if (opts.outcome === "TP2_HIT" && pos.tp2 != null) {
        r = rFromLevels(pos.side, pos.entry, pos.sl, pos.tp2);
      }
    } else {
      r = 0;
    }
  }
  r = Math.round((r as number) * 1000) / 1000;

  const pnlUsd = money2(pos.riskUsd * r);
  // Legs banked mid-runner are already in the balance; only book the delta.
  const delta = money2(pnlUsd - pos.bankedUsd);
  const now = Date.now();
  closeDemoPositionInDb(positionId, opts.outcome, r, pnlUsd, now);
  if (delta !== 0) {
    applyPnlToBalance(
      positionId,
      delta,
      opts.note ||
        `${pos.side} closed ${opts.outcome} · R=${r.toFixed(2)} · P&L $${pnlUsd.toFixed(2)}`,
      now,
      "CLOSE",
    );
  }

  const closed = {
    ...pos,
    status: "CLOSED" as const,
    outcome: opts.outcome,
    realizedR: r,
    pnlUsd,
    closedAt: now,
  };
  return { ok: true, position: closed, account: ensureDemoAccount() };
}

/**
 * Which DemoOutcome best describes how a runner finished. The enum is kept as
 * it was so History / UI classification does not change: anything that banked a
 * leg is a win, anything stopped before the first leg is a loss.
 */
function runnerOutcome(
  legsFilled: number,
  legsTotal: number,
  kind: "STOP" | "TRAIL" | "TARGET",
): DemoOutcome {
  if (legsFilled === 0) return "SL_HIT";
  // Only a multi-leg plan can reach a "TP2"; a range plan has one leg.
  if (kind === "TARGET" && legsTotal > 1) return "TP2_HIT";
  return "TP1_HIT";
}

/**
 * Ignore TV quote spikes when resolving exits (e.g. 4156 print then snap to 4100
 * falsely hits ±$2 SL). Keep last sane mid across ticks.
 */
let lastSaneResolvePrice = 0;
const RESOLVE_SPIKE_USD = 20;

/**
 * Resolve OPEN positions against the latest polled price.
 *
 * Runner positions bank legs as they fill (crediting the balance each time) and
 * only close when the ratcheting stop or the far target is hit. Stops win on
 * ambiguity, same as `simulateExit` in the backtest.
 */
export function resolveOpenAgainstPrice(live: number): {
  closed: DemoPositionRow[];
  account: DemoAccountRow;
} {
  const closed: DemoPositionRow[] = [];
  if (!Number.isFinite(live) || live <= 0) {
    return { closed, account: ensureDemoAccount() };
  }

  if (
    lastSaneResolvePrice > 0 &&
    Math.abs(live - lastSaneResolvePrice) > RESOLVE_SPIKE_USD
  ) {
    return { closed, account: ensureDemoAccount() };
  }
  lastSaneResolvePrice = live;

  for (const pos of listOpenDemoPositions()) {
    if (
      pos.module === "probeb" &&
      Math.abs(live - pos.entry) > RESOLVE_SPIKE_USD
    ) {
      const now = Date.now();
      closeDemoPositionInDb(pos.id, "MANUAL", 0, 0, now);
      closed.push({
        ...pos,
        status: "CLOSED",
        outcome: "MANUAL",
        realizedR: 0,
        pnlUsd: 0,
        closedAt: now,
        note: `${pos.note} · VOID quote-spike entry ${pos.entry} vs live ${live.toFixed(2)}`,
      });
      continue;
    }

    const plan = planForPosition(pos);
    const step = advanceRunnerOnPrice(plan, runnerStateOf(pos), live);
    const now = Date.now();

    let bankedUsd = pos.bankedUsd;
    for (const fill of step.fills) {
      const usd = money2(pos.riskUsd * fill.r);
      bankedUsd = money2(bankedUsd + usd);
      applyPnlToBalance(
        pos.id,
        usd,
        `${pos.module} ${pos.side} banked ${fill.label} @ ${fill.level.toFixed(2)} · ${(fill.fraction * 100).toFixed(0)}% · +$${usd.toFixed(2)}`,
        now,
        fill.label,
      );
    }

    if (!step.closed) {
      if (
        step.fills.length ||
        step.state.stop !== (pos.stopNow ?? pos.sl) ||
        step.state.peakPrice !== (pos.peakPrice ?? pos.entry)
      ) {
        updateDemoRunnerState(pos.id, {
          stopNow: step.state.stop,
          partsClosed: step.state.filled,
          bankedR: step.state.bankedR,
          bankedUsd,
          peakPrice: step.state.peakPrice,
        });
      }
      continue;
    }

    const remainderUsd = money2(pos.riskUsd * step.closed.remainderR);
    const totalUsd = money2(bankedUsd + remainderUsd);
    const outcome = runnerOutcome(
      step.state.filled,
      plan.legs.length,
      step.closed.kind,
    );
    const exitWord =
      step.closed.kind === "TRAIL"
        ? "trail stop"
        : step.closed.kind === "STOP"
          ? "stop"
          : "final target";

    closeDemoPositionInDb(pos.id, outcome, step.closed.totalR, totalUsd, now, {
      stopNow: step.state.stop,
      partsClosed: step.state.filled,
      bankedR: step.state.bankedR,
      bankedUsd,
      peakPrice: step.state.peakPrice,
    });
    if (remainderUsd !== 0) {
      applyPnlToBalance(
        pos.id,
        remainderUsd,
        `${pos.module} ${pos.side} ${exitWord} @ ${step.closed.exitPrice.toFixed(2)} · ${(step.closed.remainderFraction * 100).toFixed(0)}% · $${remainderUsd.toFixed(2)}`,
        now,
        "EXIT",
      );
    }

    closed.push({
      ...pos,
      status: "CLOSED",
      outcome,
      realizedR: step.closed.totalR,
      pnlUsd: totalUsd,
      closedAt: now,
      stopNow: step.state.stop,
      partsClosed: step.state.filled,
      bankedR: step.state.bankedR,
      bankedUsd,
      peakPrice: step.state.peakPrice,
    });
  }

  return { closed, account: ensureDemoAccount() };
}

/**
 * Close OPEN demo trade when the linked history source already resolved.
 *
 * A runner deliberately outlives the source plan's TP1, so for runner positions
 * only cancellations come through here — the price resolver owns TP/stop exits.
 * Otherwise the source hitting its 0.85R TP1 would close the runner and we'd be
 * back to the capped exit the runner exists to fix.
 */
export function closeFromSourceOutcome(
  sourceId: string,
  outcome: string,
  realizedR: number | null,
): TakeTradeResult | null {
  const pos = findDemoBySourceId(sourceId);
  if (!pos || pos.status !== "OPEN") return null;

  const isRunner = pos.policy != null && pos.policy !== "fixed_tp1";
  const cancelled =
    outcome === "INVALIDATED" || outcome === "REGIME_FLIP_INVALIDATED";
  if (isRunner && !cancelled) return null;

  let demoOutcome: DemoOutcome = "MANUAL";
  if (outcome === "TP1_HIT" || outcome === "TP2_HIT") demoOutcome = outcome;
  else if (outcome === "SL_HIT") demoOutcome = "SL_HIT";
  else if (outcome === "INVALIDATED" || outcome === "REGIME_FLIP_INVALIDATED") {
    // Missed / cancelled — flat close at 0R (no P&L)
    return closeDemoTrade(pos.id, {
      outcome: "MANUAL",
      realizedR: 0,
      note: `Source ${outcome} — flat close`,
    });
  } else {
    return null;
  }

  return closeDemoTrade(pos.id, {
    outcome: demoOutcome,
    realizedR:
      realizedR != null && Number.isFinite(realizedR)
        ? realizedR
        : demoOutcome === "SL_HIT"
          ? -1
          : null,
    note: `Synced from ${pos.module} ${demoOutcome}`,
  });
}

const SPIKE_PEER_USD = 25;

/**
 * Void Probeb fills opened on quote spikes (entry far from same-day peer median).
 * Refunds booked P&L so History no longer shows fake SL at e.g. 4154.
 */
export function voidProbebQuoteSpikeTrades(): number {
  ensureDemoAccount();
  const rows = listDemoPositions(150).filter((p) => p.module === "probeb");
  if (rows.length < 2) return 0;
  const sorted = [...rows].map((p) => p.entry).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  let n = 0;
  const now = Date.now();
  for (const p of rows) {
    if (Math.abs(p.entry - median) <= SPIKE_PEER_USD) continue;
    if (p.note?.includes("VOID quote-spike")) continue;

    if (p.status === "OPEN") {
      closeDemoPositionInDb(p.id, "MANUAL", 0, 0, now);
      n += 1;
      continue;
    }

    const priorPnl = p.pnlUsd ?? 0;
    if (p.outcome === "MANUAL" && priorPnl === 0) continue;
    rewriteClosedDemoPosition(p.id, {
      outcome: "MANUAL",
      realizedR: 0,
      pnlUsd: 0,
      note: `${p.note} · VOID quote-spike (entry ${p.entry} vs day mid ${median.toFixed(2)})`,
    });
    if (priorPnl !== 0) {
      applyPnlToBalance(
        p.id,
        -priorPnl,
        `Probeb VOID spike refund · was ${p.outcome} P&L $${priorPnl}`,
        now,
        "VOID_SPIKE",
      );
    }
    n += 1;
  }
  return n;
}
