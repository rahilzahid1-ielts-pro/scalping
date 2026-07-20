import type { CompareStrategy } from "./store";
import {
  countResolvedStrategy,
  getBacktestStrategyDb,
  getLatestStrategySignal,
  getLiveStrategyDb,
  summarizeStrategy,
} from "./store";
import {
  CIPHER_B_BACKTEST_SNAPSHOT,
  FRACTAL_BACKTEST_SNAPSHOT,
  isCompareBacktestValidated,
} from "./backtestSnapshot";
import { fetchMultiTimeframe } from "../services/marketData";
import { diagnoseSmcGateBlock } from "../strategies/smcGateStatus";
import { generateFractalLiveSignal } from "../strategies/fractalLive";
import { generateCipherBLiveSignal } from "../strategies/cipherBLive";

/** Shared JSON shape for GET /api/{cipherbclone|fractal}/latest */
export async function buildLatestPayload(strategy: CompareStrategy) {
  const liveDb = getLiveStrategyDb();
  const latest = getLatestStrategySignal(liveDb, strategy);
  let validated = false;
  let backtestSummary: ReturnType<typeof summarizeStrategy> | null = null;
  try {
    const bt = getBacktestStrategyDb(false);
    const n = countResolvedStrategy(bt, strategy);
    if (n > 0) {
      backtestSummary = summarizeStrategy(bt, strategy);
      validated = isCompareBacktestValidated(backtestSummary);
    }
  } catch {
    /* backtest db may not exist yet */
  }

  if (!backtestSummary) {
    const snap =
      strategy === "cipher_b_clone"
        ? CIPHER_B_BACKTEST_SNAPSHOT
        : strategy === "fractal"
          ? FRACTAL_BACKTEST_SNAPSHOT
          : null;
    if (snap) {
      backtestSummary = {
        resolved: snap.resolved,
        wins: snap.wins,
        losses: snap.losses,
        winRate: snap.winRate,
        avgR: snap.avgR,
        maxDrawdownR: snap.maxDrawdownR,
      };
      validated = isCompareBacktestValidated(backtestSummary);
    }
  }

  let waitReason: string | null = null;
  let live: {
    direction: "BUY" | "SELL";
    entry: number;
    sl: number;
    tp1: number;
    tp2: number;
  } | null = null;

  try {
    const frames = await fetchMultiTimeframe("XAUUSD", "scalping", undefined, {
      rebaseToLive: false,
    });
    const packed = { ...frames, assetId: "XAUUSD" as const, mode: "scalping" as const };

    if (strategy === "fractal") {
      // Lean fractal: direction agree only — do not block on SMC quality stack.
      const sig = generateFractalLiveSignal(packed);
      if (sig) {
        live = {
          direction: sig.direction,
          entry: sig.entry,
          sl: sig.sl,
          tp1: sig.tp1,
          tp2: sig.tp2,
        };
      } else {
        waitReason = "Fractal breakout SMC side se agree nahi (lean gate)";
      }
    } else {
      const diag = diagnoseSmcGateBlock(frames, { mode: "scalping", minConf: 75 });
      if (!diag.pass) {
        waitReason = diag.waitReason;
      } else {
        const sig =
          strategy === "cipher_b_clone" ? generateCipherBLiveSignal(packed) : null;
        if (sig) {
          live = {
            direction: sig.direction,
            entry: sig.entry,
            sl: sig.sl,
            tp1: sig.tp1,
            tp2: sig.tp2,
          };
        } else {
          waitReason = `SMC ${diag.side} ok, lekin Cipher B trigger agree nahi`;
        }
      }
    }
  } catch (e) {
    waitReason = e instanceof Error ? e.message : "market fetch failed";
  }

  return {
    ok: true as const,
    validated,
    badge: validated
      ? null
      : backtestSummary
        ? `UNVALIDATED — need ≥55% TP1win, n≥50, avgR>0 (n=${backtestSummary.resolved}, wr=${backtestSummary.winRate?.toFixed(1) ?? "—"}%)`
        : "UNVALIDATED — no backtest history yet",
    latest: latest
      ? {
          direction: latest.direction,
          entry: latest.entry,
          sl: latest.sl,
          tp1: latest.tp1,
          tp2: latest.tp2,
          reason: latest.reason,
          outcome: latest.outcome,
          time: latest.time,
        }
      : null,
    live,
    waitReason: live || latest ? null : waitReason,
    backtestSummary,
  };
}
