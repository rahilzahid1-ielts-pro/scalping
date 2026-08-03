/**
 * GET/POST payload builders for /api/demo/*
 */
import { fetchTradingViewQuoteCached } from "../services/liveQuotes";
import {
  ensureDemoAccount,
  listClosedDemoPositions,
  listDemoLedger,
  listOpenDemoPositions,
  resetDemoAccount,
  updateDemoAccountSettings,
  type DemoAccountRow,
  type DemoLedgerRow,
  type DemoPositionRow,
} from "./store";
import {
  closeDemoTrade,
  planForPosition,
  resolveOpenAgainstPrice,
  takeDemoTrade,
  unrealizedR,
  voidProbebQuoteSpikeTrades,
  type TakeTradeInput,
} from "./engine";
import { syncDemoFromHistory } from "./syncFromHistory";

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

export type DemoPositionView = DemoPositionRow & {
  floatingR: number | null;
  floatingPnl: number | null;
  /** Fraction of the original size still open (runner legs reduce it). */
  openFraction: number;
  /** True once a leg banked and the stop is at breakeven or better. */
  riskFree: boolean;
};

export async function buildDemoAccountPayload() {
  ensureDemoAccount();
  const sync = await syncDemoFromHistory();

  let live: number | null = null;
  try {
    const q = await fetchTradingViewQuoteCached("XAUUSD");
    live = q?.price ?? null;
  } catch {
    live = null;
  }

  let priceClosed: DemoPositionRow[] = [];
  if (live != null) {
    // Scrub spiked Probeb history (4104 vs live ~4035) before resolve/day PnL.
    try {
      voidProbebQuoteSpikeTrades(live);
    } catch {
      /* optional */
    }
    const res = resolveOpenAgainstPrice(live);
    priceClosed = res.closed;
  }

  const refreshed = ensureDemoAccount();
  const opens = listOpenDemoPositions().map((p) => enrichOpen(p, live));
  const floating = opens.reduce((a, p) => a + (p.floatingPnl ?? 0), 0);
  const equity = money(refreshed.balance + floating);

  const closedRecent = listClosedDemoPositions(60).filter(
    (p) => !p.note?.includes("VOID quote-spike"),
  );
  const closedToday = closedRecent.filter((p) => {
    if (p.closedAt == null) return false;
    return Date.now() - p.closedAt < 36 * 60 * 60 * 1000;
  });
  const dayPnl = money(
    closedToday.reduce((a, p) => a + (p.pnlUsd ?? 0), 0),
  );

  // Diversify recent closed: max 4 probeb so QS Pro / Cipher stay visible.
  const recentClosed: DemoPositionRow[] = [];
  let probebN = 0;
  for (const p of closedRecent) {
    if (p.module === "probeb") {
      if (probebN >= 4) continue;
      probebN += 1;
    }
    recentClosed.push(p);
    if (recentClosed.length >= 20) break;
  }

  return {
    ok: true as const,
    account: refreshed,
    equity,
    floatingPnl: money(floating),
    dayPnl,
    livePrice: live,
    openPositions: opens,
    recentPositions: [...opens, ...recentClosed],
    ledger: (() => {
      const raw = listDemoLedger(60);
      const out: typeof raw = [];
      let probebBank = 0;
      for (const l of raw) {
        if (l.note?.includes("VOID spike refund")) continue;
        if (/probeb .* banked TP1/i.test(l.note ?? "")) {
          if (probebBank >= 3) continue;
          probebBank += 1;
        }
        out.push(l);
        if (out.length >= 20) break;
      }
      return out;
    })(),
    sync: {
      ...sync,
      priceClosed: priceClosed.length,
    },
    regime: sync.regime ?? null,
    dayBudget: sync.dayBudget ?? null,
  };
}

/**
 * Floating value of a position. For a runner the banked legs are already in the
 * balance, so only the still-open fraction floats — showing the full size would
 * double-count what we have already collected.
 */
function enrichOpen(p: DemoPositionRow, live: number | null): DemoPositionView {
  const plan = planForPosition(p);
  const openFraction = Math.max(
    0,
    1 - plan.legs.slice(0, p.partsClosed).reduce((a, l) => a + l.fraction, 0),
  );
  const raw = live != null ? unrealizedR(p.side, p.entry, p.sl, live) : null;
  const r = raw == null ? null : Math.round(raw * openFraction * 1000) / 1000;
  const floatingPnl = r != null ? money(p.riskUsd * r) : null;
  const stop = p.stopNow ?? p.sl;
  const riskFree =
    p.partsClosed > 0 &&
    (p.side === "BUY" ? stop >= p.entry : stop <= p.entry);
  return { ...p, floatingR: r, floatingPnl, openFraction, riskFree };
}

export async function handleDemoTake(body: TakeTradeInput) {
  const result = takeDemoTrade(body);
  if (!result.ok) return { ok: false as const, error: result.error };
  return {
    ok: true as const,
    position: result.position,
    account: result.account,
  };
}

export async function handleDemoClose(body: {
  positionId: string;
  outcome?: "TP1_HIT" | "SL_HIT" | "MANUAL";
  realizedR?: number;
}) {
  const result = closeDemoTrade(body.positionId, {
    outcome: body.outcome ?? "MANUAL",
    realizedR: body.realizedR,
  });
  if (!result.ok) return { ok: false as const, error: result.error };
  return {
    ok: true as const,
    position: result.position,
    account: result.account,
  };
}

export async function handleDemoReset() {
  const account = resetDemoAccount(true);
  return { ok: true as const, account };
}

export async function handleDemoSettings(body: {
  riskPct?: number;
  autoFollow?: boolean;
}) {
  const account = updateDemoAccountSettings(body);
  return { ok: true as const, account };
}

export type { DemoAccountRow, DemoLedgerRow, DemoPositionRow };
