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
npm run dev          # UI (local Vite + API proxies)
npm run build        # production bundle → dist/
npm run start        # production Node server (PORT, proxies, calibration API)
npm run alerts       # background Gold/Silver/BTC alerts (Windows + optional Telegram)
npm run calibrate    # actual vs claimed win-rate report (LIVE data/signals.db)
npm run calibrate -- --days=30
npm run backtest -- --file=C:\gold-trading-engine\data\XAUUSD_M5.json --days=365
```

### Phone alerts jab web band ho (Railway + Telegram)

Browser band hone pe notifications ke liye Railway Variables set karo:

1. Telegram `@BotFather` se bot token lo  
2. Apna `TELEGRAM_CHAT_ID` lo  
3. Railway pe:
   - `TELEGRAM_BOT_TOKEN=...`
   - `TELEGRAM_CHAT_ID=...`
   - `ENABLE_ALERT_WORKER=1`
4. Redeploy — har alert pe **Gold / Silver / Bitcoin** clearly likha aayega (zone lock + entry hit)

Open the URL Vite prints (default `http://localhost:5173`).

### Backtest (past results of the SAME formula)

```bash
npm run backtest -- --file=C:\gold-trading-engine\data\XAUUSD_M5.json --days=365 --spread=0.25
```

- Uses production `generateSignal` (EMA/SMC/PA) — not a copy.
- Base series: ForexSB/Dukas **M5 JSON** (`time/open/high/low/close` arrays; time = minutes since 2000-01-01 **UTC**). HTF (15m/1H/4H/Daily) are **resampled in-code** from that series only.
- Walk-forward on closed bars only; incomplete HTF candles are never fed to the engine (anti look-ahead).
- Outcomes use the same gap/tie rules as live (`advanceSignalOnBar` → ties prefer SL).
- Results in **`data/backtest-results.db` only** — never merges into live `data/signals.db`.
- Default Gold spread **$0.25** on entry (`--spread=0`); set `0` only if you accept optimistic fills.
- Report tables match `npm run calibrate`. Sanity banners flag win rate >75% and empty/overstuffed months.

### Railway deploy

Static-only hosting breaks live signals: `/api/*` must return JSON, not `index.html`.
This repo ships `server/prodServer.ts` for that.

1. Connect the GitHub repo to Railway.
2. Build / start come from [`railway.toml`](railway.toml): `npm ci && npm run build` → `npm run start`.
3. Railway sets `PORT` automatically; the server binds `0.0.0.0:$PORT`.
4. **Optional but recommended:** mount a Volume at `/app/data` so `data/signals.db` persists across redeploys. Without it, calibration history resets every deploy (quotes/signals still work).
5. After deploy, open the public URL — Gold/Scalp should load without `Unexpected token '<'`. Check Network: `/api/tv/.../scan` and `/api/yahoo/...` return JSON.

Local production smoke test:

```bash
npm run build && npm run start
# then open http://localhost:4173
```

### Calibration report (how to read)

Signals are logged to **SQLite** (`data/signals.db`, WAL mode). Legacy `data/signal-log.json`
is imported once on first open, then renamed to `signal-log.json.migrated` (not deleted).

**Live vs backtest (do not mix):**

- Live measurement uses **only** `data/signals.db` (alerts bot + Vite API + `npm run calibrate`).
- A future backtest must use **`data/backtest-results.db`** (`BACKTEST_RESULTS_DB_PATH`) with its
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
