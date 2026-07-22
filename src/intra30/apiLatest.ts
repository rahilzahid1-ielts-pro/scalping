/**
 * Shared JSON for GET /api/intra30/latest (vite + prodServer).
 */
import { fetchMultiTimeframe } from "../services/marketData";
import { generateIntra30Signal } from "../strategies/intra30Engine";
import { diagnoseSmcGateBlock } from "../strategies/smcGateStatus";
import { INTRADAY_LOCK_MIN_CONF } from "../utils/sessionPlan";
import {
  getLiveIntra30Db,
  getOpenOrLatestIntra30,
  getBacktestIntra30Db,
  summarizeIntra30,
  countResolvedIntra30,
  isIntra30BacktestValidated,
} from "./store";
import {
  selectUiLatest,
  withHistoryOpenLatest,
} from "../history/withHistoryOpen";

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
    /* no local backtest DB */
  }

  if (!backtestSummary) {
    backtestSummary = {
      resolved: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      avgR: null,
      maxDrawdownR: null,
    };
    validated = false;
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
    const frames = await fetchMultiTimeframe("XAUUSD", "intraday", undefined, {
      rebaseToLive: true,
    });
    const sig = generateIntra30Signal("XAUUSD", frames);
    if (sig) {
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
    } else {
      const diag = diagnoseSmcGateBlock(frames, {
        mode: "intraday",
        minConf: INTRADAY_LOCK_MIN_CONF,
      });
      waitReason = diag.pass
        ? "Intraday gates soft-pass but Intra30 engine null"
        : diag.waitReason;
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
    backtestSummary,
    badge: validated
      ? null
      : `UNVALIDATED — need ≥58% TP1win, n≥50, avgR>0 (now n=${backtestSummary.resolved}, wr=${backtestSummary.winRate?.toFixed(1) ?? "—"}%, avgR=${backtestSummary.avgR?.toFixed(2) ?? "—"})`,
  };
}
