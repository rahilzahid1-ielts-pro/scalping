/**
 * Committed snapshot from `npx tsx scripts/backtestIntra30.ts`
 * (365d XAUUSD M5, spread 0.25, pehli-strong + H1 same color, SL$5,
 * post-resolve cooldown 5 bars, opposite block 6 bars).
 *
 * NOTE: still shy of validation gate (≥58% TP1win) — wr 55.1%, avgR ~0.
 * Re-run and update when the formula changes.
 */
export const INTRA30_BACKTEST_SNAPSHOT = {
  resolved: 1393,
  wins: 767,
  losses: 626,
  winRate: 55.06101938262742,
  avgR: 0.004594400574299998,
  maxDrawdownR: -48.2,
  meta: {
    file: "data/XAUUSD_M5.json",
    days: 365,
    spread: 0.25,
    runAt: "2026-07-22",
    rules:
      "pehli strong M5 body≥85% wick≤8% + H1 same color → next open; TP1$3 TP2$6 SL$5; cooldown 5 bars; opposite block 6 bars; weak exit after TP1",
    vsV1: "v1 ungated: n=3133 wr=38.3% avgR=-0.084 maxDD=-268",
  },
} as const;
