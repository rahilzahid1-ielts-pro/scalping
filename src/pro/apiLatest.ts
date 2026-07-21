/**
 * Shared JSON for GET /api/pro/latest (vite + prodServer).
 */
import { fetchMultiTimeframe } from "../services/marketData";
import { generateProSignal } from "../strategies/proEngine";
import { diagnoseSmcGateBlock } from "../strategies/smcGateStatus";
import {
  getLiveProDb,
  getOpenOrLatestPro,
  getBacktestProDb,
  summarizePro,
  countResolvedPro,
  isProBacktestValidated,
} from "./store";
import { PRO_BACKTEST_SNAPSHOT } from "./backtestSnapshot";
import { withHistoryOpenLatest } from "../history/withHistoryOpen";

export async function buildProLatestPayload() {
  const liveDb = getLiveProDb();
  const candidate = getOpenOrLatestPro(liveDb);
  const rawLatest = candidate?.outcome === "OPEN" ? candidate : null;
  const latest = withHistoryOpenLatest("pro", rawLatest, (o) => ({
    id: "history-open-pro",
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
    strategy: "pro" as const,
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
    const bt = getBacktestProDb(false);
    const n = countResolvedPro(bt);
    if (n > 0) {
      backtestSummary = summarizePro(bt);
      validated = isProBacktestValidated(backtestSummary);
    }
  } catch {
    /* no local backtest DB — fall through to snapshot */
  }

  if (!backtestSummary) {
    backtestSummary = {
      resolved: PRO_BACKTEST_SNAPSHOT.resolved,
      wins: PRO_BACKTEST_SNAPSHOT.wins,
      losses: PRO_BACKTEST_SNAPSHOT.losses,
      winRate: PRO_BACKTEST_SNAPSHOT.winRate,
      avgR: PRO_BACKTEST_SNAPSHOT.avgR,
      maxDrawdownR: PRO_BACKTEST_SNAPSHOT.maxDrawdownR,
    };
    validated = isProBacktestValidated(backtestSummary);
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
    const sig = generateProSignal("XAUUSD", frames, "intraday");
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
      const diag = diagnoseSmcGateBlock(frames, { mode: "intraday", minConf: 80 });
      waitReason = diag.pass ? "Gates pass-ish but Pro engine null" : diag.waitReason;
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
