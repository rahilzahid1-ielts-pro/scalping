/**
 * Demo account engine — open / close / price-resolve / history sync.
 * Risk sized from *starting* balance × riskPct (not current balance).
 * Open trades / low balance never block new setups — test every signal.
 */
import {
  applyPnlToBalance,
  closeDemoPositionInDb,
  DEMO_ACCOUNT_ID,
  DEMO_STARTING_BALANCE,
  ensureDemoAccount,
  findDemoBySourceId,
  insertDemoPosition,
  listOpenDemoPositions,
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
};

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
    if (opts.outcome === "SL_HIT") r = -1;
    else if (opts.outcome === "TP1_HIT" || opts.outcome === "TP2_HIT") {
      r = rFromLevels(pos.side, pos.entry, pos.sl, pos.tp1);
      if (opts.outcome === "TP2_HIT" && pos.tp2 != null) {
        r = rFromLevels(pos.side, pos.entry, pos.sl, pos.tp2);
      }
    } else {
      r = 0;
    }
  }

  const pnlUsd = Math.round(pos.riskUsd * (r as number) * 100) / 100;
  const now = Date.now();
  closeDemoPositionInDb(positionId, opts.outcome, r as number, pnlUsd, now);
  applyPnlToBalance(
    positionId,
    pnlUsd,
    opts.note ||
      `${pos.side} closed ${opts.outcome} · R=${(r as number).toFixed(2)} · P&L $${pnlUsd.toFixed(2)}`,
    now,
  );

  const closed = { ...pos, status: "CLOSED" as const, outcome: opts.outcome, realizedR: r as number, pnlUsd, closedAt: now };
  return { ok: true, position: closed, account: ensureDemoAccount() };
}

/**
 * Resolve OPEN positions against live mid (SL-first if both in same tick).
 */
export function resolveOpenAgainstPrice(live: number): {
  closed: DemoPositionRow[];
  account: DemoAccountRow;
} {
  const closed: DemoPositionRow[] = [];
  if (!Number.isFinite(live) || live <= 0) {
    return { closed, account: ensureDemoAccount() };
  }

  for (const pos of listOpenDemoPositions()) {
    let hit: DemoOutcome | null = null;
    if (pos.side === "BUY") {
      if (live <= pos.sl) hit = "SL_HIT";
      else if (live >= pos.tp1) hit = "TP1_HIT";
    } else {
      if (live >= pos.sl) hit = "SL_HIT";
      else if (live <= pos.tp1) hit = "TP1_HIT";
    }
    if (!hit) continue;
    const res = closeDemoTrade(pos.id, {
      outcome: hit,
      note: `Auto resolve @ live ${live.toFixed(2)}`,
    });
    if (res.ok) closed.push(res.position);
  }

  return { closed, account: ensureDemoAccount() };
}

/** Close OPEN demo trade when linked history source already resolved. */
export function closeFromSourceOutcome(
  sourceId: string,
  outcome: string,
  realizedR: number | null,
): TakeTradeResult | null {
  const pos = findDemoBySourceId(sourceId);
  if (!pos || pos.status !== "OPEN") return null;

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
