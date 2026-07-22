/**
 * Shared JSON for GET /api/intra30/latest (vite + prodServer).
 */
import { fetchMultiTimeframe } from "../services/marketData";
import { fetchTradingViewQuoteCached } from "../services/liveQuotes";
import {
  diagnoseIntra30,
  generateIntra30Signal,
} from "../strategies/intra30Engine";
import {
  getLiveIntra30Db,
  getOpenOrLatestIntra30,
  getBacktestIntra30Db,
  summarizeIntra30,
  countResolvedIntra30,
  isIntra30BacktestValidated,
  listOpenIntra30,
} from "./store";
import { INTRA30_BACKTEST_SNAPSHOT } from "./backtestSnapshot";
import {
  selectUiLatest,
  withHistoryOpenLatest,
} from "../history/withHistoryOpen";

/** Same guard as bot — hide Yahoo-skewed preview levels. */
const MAX_ENTRY_LIVE_GAP = 4;

export async function buildIntra30LatestPayload() {
  const liveDb = getLiveIntra30Db();
  const candidate = getOpenOrLatestIntra30(liveDb);
  const rawLatest = selectUiLatest(candidate);
  const latest = withHistoryOpenLatest("intra30", rawLatest, (o) => ({
    id: "history-open-intra30",
    timestamp: o.time,
    symbol: "XAUUSD",
    direction: o.direction,
    entry: o.entry,
    sl: o.sl,
    tp1: o.tp1,
    tp2: o.tp2,
    confidence: o.confidence ?? 0,
    regime: o.regime ?? "",
    outcome: "OPEN" as const,
    reason: o.reason,
    dailyBias: o.dailyBias ?? "",
    strategy: "intra30" as const,
    realizedR: null,
    resolvedAt: null,
    executedAt: o.executedAt ?? null,
    source: "live" as const,
    strongBarTime: null,
  }));

  let backtestSummary: {
    resolved: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgR: number | null;
    maxDrawdownR: number | null;
  } | null = null;
  let validated = false;

  try {
    const bt = getBacktestIntra30Db(false);
    const n = countResolvedIntra30(bt);
    if (n > 0) {
      backtestSummary = summarizeIntra30(bt);
      validated = isIntra30BacktestValidated(backtestSummary);
    }
  } catch {
    /* no local backtest DB — fall through to snapshot */
  }

  if (!backtestSummary || backtestSummary.resolved === 0) {
    backtestSummary = {
      resolved: INTRA30_BACKTEST_SNAPSHOT.resolved,
      wins: INTRA30_BACKTEST_SNAPSHOT.wins,
      losses: INTRA30_BACKTEST_SNAPSHOT.losses,
      winRate: INTRA30_BACKTEST_SNAPSHOT.winRate,
      avgR: INTRA30_BACKTEST_SNAPSHOT.avgR,
      maxDrawdownR: INTRA30_BACKTEST_SNAPSHOT.maxDrawdownR,
    };
    validated = isIntra30BacktestValidated(backtestSummary);
  }

  let waitReason: string | null = null;
  let live: {
    direction: "BUY" | "SELL";
    entry: number;
    sl: number;
    tp1: number;
    tp2: number;
    confidence: number;
    regime: string;
    dailyBias: string;
  } | null = null;

  try {
    const quote = await fetchTradingViewQuoteCached("XAUUSD");
    const frames = await fetchMultiTimeframe("XAUUSD", "scalping", quote.price, {
      rebaseToLive: true,
    });
    const sig = generateIntra30Signal("XAUUSD", frames);
    if (sig && Math.abs(sig.entry - quote.price) <= MAX_ENTRY_LIVE_GAP) {
      live = {
        direction: sig.direction,
        entry: sig.entry,
        sl: sig.sl,
        tp1: sig.tp1,
        tp2: sig.tp2,
        confidence: sig.confidence,
        regime: sig.regime,
        dailyBias: sig.dailyBias,
      };
    } else if (sig) {
      waitReason = `Intra30: entry ${sig.entry.toFixed(2)} desk mid ${quote.price.toFixed(2)} se door — Yahoo skew skip`;
    } else {
      waitReason = diagnoseIntra30(frames).waitReason;
    }
  } catch (e) {
    waitReason = e instanceof Error ? e.message : "market fetch failed";
  }

  return {
    ok: true as const,
    validated,
    latest,
    live,
    waitReason: live || latest ? null : waitReason,
    historyOpen: latest?.outcome === "OPEN",
    openCount: listOpenIntra30(liveDb).length,
    backtestSummary,
    badge: validated
      ? null
      : `UNVALIDATED — need ≥55% TP1win, n≥50, avgR>0 (now n=${backtestSummary.resolved}, wr=${backtestSummary.winRate?.toFixed(1) ?? "—"}%, avgR=${backtestSummary.avgR?.toFixed(2) ?? "—"})`,
  };
}
