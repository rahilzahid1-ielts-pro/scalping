/**
 * Shared JSON for GET /api/quickscalp/latest (vite + prodServer).
 * Includes live market gate status so WAITING is not a black box.
 */
import { fetchMultiTimeframe } from "../services/marketData";
import { generateQuickScalpSignal } from "../strategies/quickScalpEngine";
import { diagnoseSmcGateBlock } from "../strategies/smcGateStatus";
import {
  getLiveQuickScalpDb,
  getOpenOrLatestQuickScalp,
  getBacktestQuickScalpDb,
  summarizeQuickScalp,
  countResolvedQuickScalp,
} from "./store";
import {
  QUICK_SCALP_BACKTEST_SNAPSHOT,
  isQuickScalpBacktestValidated,
} from "./backtestSnapshot";
import { withHistoryOpenLatest } from "../history/withHistoryOpen";

export async function buildQuickScalpLatestPayload() {
  const liveDb = getLiveQuickScalpDb();
  const candidate = getOpenOrLatestQuickScalp(liveDb);
  const rawLatest = candidate?.outcome === "OPEN" ? candidate : null;
  const latest = withHistoryOpenLatest("quick_scalp", rawLatest, (o) => ({
    id: `history-open-qs`,
    timestamp: o.time,
    symbol: "XAUUSD",
    direction: o.direction,
    entry: o.entry,
    sl: o.sl,
    tp1: o.tp1,
    tp2: o.tp2,
    outcome: "OPEN" as const,
    reason: o.reason,
    dailyTrend: o.dailyBias ?? "",
    strategy: "quick_scalp" as const,
    realizedR: null,
    resolvedAt: null,
    executedAt: o.executedAt ?? null,
    source: "live" as const,
  }));
  let backtestSummary: ReturnType<typeof summarizeQuickScalp> | null = null;
  let validated = false;

  try {
    const bt = getBacktestQuickScalpDb(false);
    const n = countResolvedQuickScalp(bt);
    if (n > 0) {
      backtestSummary = summarizeQuickScalp(bt);
      validated = isQuickScalpBacktestValidated(backtestSummary);
    }
  } catch {
    /* no local DB */
  }

  if (!backtestSummary) {
    backtestSummary = {
      resolved: QUICK_SCALP_BACKTEST_SNAPSHOT.resolved,
      wins: QUICK_SCALP_BACKTEST_SNAPSHOT.wins,
      losses: QUICK_SCALP_BACKTEST_SNAPSHOT.losses,
      winRate: QUICK_SCALP_BACKTEST_SNAPSHOT.winRate,
      avgR: QUICK_SCALP_BACKTEST_SNAPSHOT.avgR,
      maxDrawdownR: QUICK_SCALP_BACKTEST_SNAPSHOT.maxDrawdownR,
    };
    validated = isQuickScalpBacktestValidated(backtestSummary);
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
    dailyTrend: string;
  } | null = null;

  try {
    const frames = await fetchMultiTimeframe("XAUUSD", "scalping", undefined, {
      rebaseToLive: true,
    });
    const diag = diagnoseSmcGateBlock(frames, { mode: "scalping", minConf: 75 });
    if (!diag.pass) {
      waitReason = diag.waitReason;
    } else {
      const sig = generateQuickScalpSignal(frames, "XAUUSD", "scalping");
      if (sig) {
        live = {
          direction: sig.direction,
          entry: sig.entry,
          sl: sig.sl,
          tp1: sig.tp1,
          tp2: sig.tp2,
          confidence: sig.confidence,
          regime: sig.regime,
          dailyTrend: sig.dailyTrend,
        };
      } else {
        waitReason = "Gates pass-ish but BLITZ engine null";
      }
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
      : `UNVALIDATED — need ≥55% TP1win, n≥50, avgR>0 (n=${backtestSummary.resolved}, wr=${backtestSummary.winRate?.toFixed(1) ?? "—"}%)`,
  };
}
