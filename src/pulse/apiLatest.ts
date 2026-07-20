import { fetchMultiTimeframe } from "../services/marketData";
import { generatePulseSignal } from "../strategies/pulseEngine";
import {
  getLivePulseDb,
  getOpenOrLatestPulse,
  getBacktestPulseDb,
  summarizePulse,
  countResolvedPulse,
} from "./store";
import {
  PULSE_BACKTEST_SNAPSHOT,
  isPulseBacktestValidated,
} from "./backtestSnapshot";

export async function buildPulseLatestPayload() {
  const liveDb = getLivePulseDb();
  const latest = getOpenOrLatestPulse(liveDb);
  let backtestSummary: ReturnType<typeof summarizePulse> | null = null;
  let validated = false;

  try {
    const bt = getBacktestPulseDb(false);
    const n = countResolvedPulse(bt);
    if (n > 0) {
      backtestSummary = summarizePulse(bt);
      validated = isPulseBacktestValidated(backtestSummary);
    }
  } catch {
    /* no local DB */
  }

  if (!backtestSummary) {
    backtestSummary = {
      resolved: PULSE_BACKTEST_SNAPSHOT.resolved,
      wins: PULSE_BACKTEST_SNAPSHOT.wins,
      losses: PULSE_BACKTEST_SNAPSHOT.losses,
      winRate: PULSE_BACKTEST_SNAPSHOT.winRate,
      avgR: PULSE_BACKTEST_SNAPSHOT.avgR,
      maxDrawdownR: PULSE_BACKTEST_SNAPSHOT.maxDrawdownR,
    };
    validated = isPulseBacktestValidated(backtestSummary);
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
    const frames = await fetchMultiTimeframe("XAUUSD", "scalping", undefined, {
      rebaseToLive: false,
    });
    const sig = generatePulseSignal(frames, "XAUUSD", "scalping");
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
      waitReason =
        "QS Pro: SMC BUY/SELL + fractal breakout agree chahiye (lean gate)";
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
    backtestSummary,
    badge: validated
      ? null
      : `UNVALIDATED — need ≥55% TP1win, n≥50, avgR>0 (n=${backtestSummary.resolved}, wr=${backtestSummary.winRate?.toFixed(1) ?? "—"}%)`,
  };
}
