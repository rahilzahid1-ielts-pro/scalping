/**
 * GET/POST payload builders for /api/demo/*
 */
import { fetchTradingViewQuoteCached } from "../services/liveQuotes";
import {
  ensureDemoAccount,
  listDemoLedger,
  listDemoPositions,
  listOpenDemoPositions,
  resetDemoAccount,
  updateDemoAccountSettings,
  type DemoAccountRow,
  type DemoLedgerRow,
  type DemoPositionRow,
} from "./store";
import {
  closeDemoTrade,
  resolveOpenAgainstPrice,
  takeDemoTrade,
  unrealizedR,
  type TakeTradeInput,
} from "./engine";
import { syncDemoFromHistory } from "./syncFromHistory";

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

export type DemoPositionView = DemoPositionRow & {
  floatingR: number | null;
  floatingPnl: number | null;
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
    const res = resolveOpenAgainstPrice(live);
    priceClosed = res.closed;
  }

  const refreshed = ensureDemoAccount();
  const opens = listOpenDemoPositions().map((p) => enrichOpen(p, live));
  const floating = opens.reduce((a, p) => a + (p.floatingPnl ?? 0), 0);
  const equity = money(refreshed.balance + floating);

  const closedToday = listDemoPositions(200).filter((p) => {
    if (p.status !== "CLOSED" || p.closedAt == null) return false;
    const age = Date.now() - p.closedAt;
    return age < 36 * 60 * 60 * 1000;
  });
  const dayPnl = money(
    closedToday.reduce((a, p) => a + (p.pnlUsd ?? 0), 0),
  );

  return {
    ok: true as const,
    account: refreshed,
    equity,
    floatingPnl: money(floating),
    dayPnl,
    livePrice: live,
    openPositions: opens,
    recentPositions: listDemoPositions(30),
    ledger: listDemoLedger(30),
    sync: {
      ...sync,
      priceClosed: priceClosed.length,
    },
  };
}

function enrichOpen(p: DemoPositionRow, live: number | null): DemoPositionView {
  const r =
    live != null ? unrealizedR(p.side, p.entry, p.sl, live) : null;
  const floatingPnl =
    r != null ? money(p.riskUsd * r) : null;
  return { ...p, floatingR: r, floatingPnl };
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
