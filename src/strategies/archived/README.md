# Archived strategies (measurement only — retired from production)

These three standalone engines were backtested on **1 year of XAUUSD M5** data
(`spread=$0.25`) and **underperformed** the main session-lock strategy's
baseline (~**60%** conditional TP1 / **+0.341R**).

| Strategy | Signals | Win rate | Avg R | Max DD R |
|----------|---------|----------|-------|----------|
| Cipher B Clone (WaveTrend-only) | 4230 | 47.6% | −0.048 | −215 |
| Fractal (Bill Williams) | 3868 | 47.6%* | −0.048* | −187 |
| ICT (killzone + sweep + FVG) | 3 | 0% | −1.000 | −3 |

\*Full precision: Cipher 47.5887% / −0.048227; Fractal 47.6080% / −0.047841
(COMPARE-line rounding made them look identical; rows were verified distinct).

ICT's sample (n=3) is too small to judge.

They were **retired from the live UI / auto-start bots / public latest APIs**
rather than tuned. Historical rows remain in `strategy_signals` (live +
backtest DBs) as an evidence trail — that table is no longer written by
production workers.

`waveTrend.ts` stays in `src/indicators/` because **Quick Scalp** still uses it.

Backtest CLI flags (`--strategy=cipher_b_clone|ict|fractal`) still work for
re-measurement against archived engines; bots under `daemon/` are kept but
not auto-started.
