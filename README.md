# SMC Signal Desk — Gold · Silver · Bitcoin

Live trading signal web app with **TradingView charts**, multi-timeframe OHLC analysis, and a confluence engine built around:

- **Smart Money Concepts** — market structure, BOS / CHoCH, order blocks, FVG, liquidity sweeps, premium/discount
- **Moving averages** — EMA 9 / 21 / 50 / 200 stack + crossovers
- **Price action** — pin bars, engulfing, inside-bar breaks, momentum sequences

## Features

- Live charts: XAU/USD, XAG/USD, BTC/USD (TradingView)
- Modes: **Scalping** and **Intraday**
- Live **BUY / SELL / WAIT** with confidence %
- Entry, Stop Loss, TP1–TP3, R:R
- **Today's daily bias** + **Tomorrow bias** with start zone & key level
- Auto-refresh every 30 seconds

## Run

```bash
npm install
npm run dev          # UI
npm run alerts       # background outcome watcher + entry alerts
npm run calibrate    # actual vs claimed win-rate report
npm run calibrate -- --days=30
```

Open the URL Vite prints (default `http://localhost:5173`).

### Calibration report (how to read)

Signals are logged to **SQLite** (`data/signals.db`, WAL mode). Legacy `data/signal-log.json`
is imported once on first open, then renamed to `signal-log.json.migrated` (not deleted).

**Live vs backtest (do not mix):**

- Live measurement uses **only** `data/signals.db` (alerts bot + Vite API + `npm run calibrate`).
- A future backtest must use **`data/backtest-signals.db`** (`BACKTEST_SIGNAL_DB_PATH`) with its
  own DB handle — never `getDb()` / `insertSignal()` from the live module.
- **Never merge, copy, ATTACH, or import** backtest rows into live `signals.db`. That leak
  inflates win rates and destroys the live calibration discipline.

**Win definitions (exact):**

- **outcomeTp1 / TP1win% (primary)** — `WIN` if TP1 is touched before SL; `LOSS` if SL is
  touched before TP1. This is what the card’s “win chance” claims, and it drives Brier +
  UNTRUSTED flags.
- **realizedR_full / avgR_f** — assumes standard 3-part scaling: close **1/3** at each of
  TP1 / TP2 / TP3; after TP1, stop for the remaining size moves to **entry (breakeven)**.
  Pre-TP1 SL = **−1.0 R**. Remaining thirds stopped at breakeven contribute **0 R**.

Report columns:

- **claimed~** — midpoint of the formula confidence bucket (not a true probability)
- **TP1win%** — `WIN / (WIN + LOSS)` on `outcomeTp1`
- **avgR_f** — average `realizedR_full` among fully closed plans in that bucket
- **Brier** — MSE of displayed win% vs TP1 WIN/LOSS (lower is better)
- **UNTRUSTED** — TP1win% is more than 15 points worse than claimed~

Also split by BUY/SELL, scalp/intraday, conflict-capped trades, and **per-regime**
(`TREND_UP` / `TREND_DOWN` / `RANGE`). Warns when >70% of a bucket comes from one regime
or one calendar day.

**UI win% stays on the raw formula** until a bucket has ≥14 days of resolved history,
≥50 samples, ≥2 distinct regimes, and ≥5 distinct calendar days — then
`getCalibratedWinChance` can replace it. Until then this is measurement only.

If MA or SMC opposes the call, **both confidence and win chance** are capped at **65%**
(`conflictCapped` is logged) and the UI shows a conflict flag.


## Data sources

| Asset   | Chart              | Signal OHLC                          |
|---------|--------------------|--------------------------------------|
| Gold    | TradingView OANDA  | Yahoo Finance `GC=F` (via Vite proxy)|
| Silver  | TradingView OANDA  | Yahoo Finance `SI=F` (via Vite proxy)|
| Bitcoin | TradingView Binance| Binance public klines (via proxy)    |

## Strategy logic (high probability filter)

1. Daily / HTF bias must agree (do not fight strong daily bias)
2. SMC structure + BOS/CHoCH / OB / FVG in premium or discount
3. MA trend alignment on entry + confirmation TF
4. Price-action trigger candle
5. Only fire BUY/SELL when confluence edge clears the mode threshold; otherwise **WAIT**

## Disclaimer

Educational tool only — not financial advice. Always confirm levels on the live chart and manage risk.
