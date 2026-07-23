/**
 * Committed snapshot from `npx tsx scripts/backtestIntra30.ts`
 * Best pack: strict M5 90%/5% + H1/Daily same + no chase + 1 OPEN,
 * SL$5 / TP1$3 / TP2$6, cooldown bars, 365d spread 0.25.
 *
 * Badge gate: ≥55% TP1win, n≥50, avgR>0 → VALIDATED on this run.
 */
export const INTRA30_BACKTEST_SNAPSHOT = {
  resolved: 193,
  wins: 109,
  losses: 84,
  winRate: 56.476683937823836,
  avgR: 0.027979274611398916,
  maxDrawdownR: -16.4,
  meta: {
    file: "data/XAUUSD_M5.json",
    days: 365,
    spread: 0.25,
    runAt: "2026-07-22",
    rules:
      "strict M5 body≥90% wick≤5% + H1/Daily same + no 2h chase + 1 OPEN; TP1$3 TP2$6 SL$5; cooldown 5 / opposite 6",
    workerDefault: "ON on Railway (ENABLE_INTRA30_WORKER=0 to disable)",
    validateMinWr: 55,
  },
} as const;
