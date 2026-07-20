import type { CompareStrategy } from "./store";
import {
  countResolvedStrategy,
  getBacktestStrategyDb,
  getLatestStrategySignal,
  getLiveStrategyDb,
  summarizeStrategy,
} from "./store";

/** Shared JSON shape for GET /api/{cipherbclone|ict|fractal}/latest */
export function buildLatestPayload(strategy: CompareStrategy) {
  const liveDb = getLiveStrategyDb();
  const latest = getLatestStrategySignal(liveDb, strategy);
  let validated = false;
  let backtestSummary = null;
  try {
    const bt = getBacktestStrategyDb(false);
    const n = countResolvedStrategy(bt, strategy);
    if (n > 0) {
      validated = true;
      backtestSummary = summarizeStrategy(bt, strategy);
    }
  } catch {
    /* backtest db may not exist yet */
  }
  return {
    ok: true,
    validated,
    badge: validated ? null : "UNVALIDATED — no backtest history yet",
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
    backtestSummary,
  };
}
