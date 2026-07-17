# SMC Trade Alert Desk — Full System Report

**Project:** `C:\scalping` (Gold · Silver · Bitcoin)  
**Stack:** React + Vite + TypeScript · TradingView charts · Node background alert bot  
**Disclaimer:** Educational signal system only — not financial advice. Past formulas do not guarantee future wins.

---

## 1. What the program is

A local trading desk that:

1. Shows **live TradingView charts** (XAU/USD, XAG/USD, BTC/USD)
2. Pulls **live OHLC + quotes**
3. Runs a **rules engine** (Smart Money + EMA + Price Action)
4. Shows one clear action: **ABHI KUCH MAT KARO / ENTRY WAIT / AB BUY|SELL LO**
5. Locks **Entry · SL · TP** so numbers don’t jump every tick
6. Can alert in **browser** and via **background bot** (`npm run alerts`) even if the tab is closed

### How to run

| Command | Purpose |
|---------|---------|
| `npm run dev` | Web UI → http://localhost:5173 |
| `npm run alerts` | Background bot (Windows toast + beeps) — keep terminal open |
| `npm run calibrate` | Actual vs claimed win-rate report (`data/signals.db`) |
| `npm run calibrate -- --days=14` | Same report, custom lookback |

### Calibration (measurement)

Every BUY/SELL is logged to **SQLite** (`data/signals.db`, WAL). Outcomes track **TP1 WIN/LOSS** (primary) plus post-TP1 TP2/TP3/breakeven for `realizedR_full` (1/3 scale-out; SL→entry after TP1). Run `npm run calibrate` for claimed vs actual by bucket, side, mode, and regime. UNTRUSTED if TP1 win rate is >15pts below claimed. Displayed win% stays raw until ≥14 days + ≥50 samples + ≥2 regimes + ≥5 calendar days. Conflicting MA/SMC vs call → confidence **and** win chance capped at 65% (`conflictCapped`).

---

## 2. Project structure

```
src/
  App.tsx                 → UI + plan freeze + live refresh
  config/assets.ts        → symbols, decimals, TV tickers
  services/
    marketData.ts         → multi-TF candles (Yahoo / Binance)
    liveQuotes.ts         → live close/bid/ask (TradingView scanner)
    tradePlan.ts          → frozen plan + localStorage
    http.ts               → browser proxy vs Node direct APIs
  strategies/
    signalEngine.ts       → BUY/SELL/WAIT + levels + confidence
    movingAverages.ts     → EMA 9/21/50/200
    smartMoney.ts         → BOS/CHoCH/OB/FVG/liquidity/premium-discount
    priceAction.ts        → pin / engulfing / inside bar
    rangePrediction.ts    → From→To path + win %
    indicators.ts         → ATR, RSI, pivots, swings
  utils/
    nowAction.ts          → “AB RIGHT NOW” decision
    tradeSafety.ts        → entry zone, min SL, too-late checks
  hooks/                  → live price poll, sound alert, service worker
  components/             → ActionNow, chart, advanced panels
daemon/
  alertBot.ts             → background monitor
  planStore.ts / state.json
public/sw.js              → notification helper when tab open but hidden
```

---

## 3. Market data & symbols

| Asset | Chart (TradingView) | Quote feed | Candle OHLC |
|-------|---------------------|------------|-------------|
| Gold XAUUSD | `OANDA:XAUUSD` | TV CFD scanner close | Yahoo `GC=F` (rebased to live) |
| Silver XAGUSD | `TVC:SILVER` | TV CFD scanner close | Yahoo `SI=F` (rebased to live) |
| Bitcoin BTCUSD | `BINANCE:BTCUSDT` | Binance book / TV crypto | Binance klines |

**Live price rule (metals):** prefer **last close**, not lagged bid/ask mid.  
**Candles:** OHLC is scaled (`rebaseCandlesToLive`) so structure matches live quote level.

### Timeframes by mode

| Mode | Primary (entry) | Confirm | Bias HTF | Daily |
|------|-----------------|---------|----------|-------|
| Scalping | 5m | 15m | 1H | 1D |
| Intraday | 15m | 1H | 4H | 1D |

**UI refresh:** live quote ~500ms · signal rescan ~30–60s  
**Bot poll:** every 2.5s

---

## 4. Signal pipeline (how BUY / SELL / WAIT is decided)

```
Candles (multi-TF)
    → Moving Averages analysis
    → Smart Money analysis
    → Price Action analysis
    → Weighted confluence score (bullPts vs bearPts)
    → HTF alignment gate
    → Daily bias block (don’t fight strong day bias)
    → Side = BUY | SELL | WAIT
    → buildLevels (Entry, SL, TP1–3)
    → rangePrediction (From→To + win %)
    → Frozen plan lock
    → nowAction (WAIT_ENTRY / ENTER_NOW / …)
    → Alert if ENTER_NOW + high conf/win + price in zone
```

---

## 5. Strategy modules & formulas

### 5.1 Moving Averages (`movingAverages.ts`)

- **EMA 9, 21, 50, 200** on closes
- Bullish stack: `EMA9 > EMA21 > EMA50 > EMA200`
- Bearish stack: opposite
- Crossover: EMA9 crosses EMA21
- Filter: price vs EMA200

**Role:** trend filter (not sole entry trigger)

### 5.2 Smart Money Concepts (`smartMoney.ts`)

| Concept | Logic (simplified) |
|---------|-------------------|
| Structure | Swing HH/HL = bullish; LH/LL = bearish |
| BOS | Close breaks last swing high/low in direction |
| CHoCH | Structure flips (early reversal cue) |
| Order Block | Last opposing candle before impulse |
| FVG | Gap between candle[i-2] and candle[i] |
| Liquidity sweep | Wick beyond swing then close back |
| Premium / Discount | Position in last ~50-bar range: >62% premium, <38% discount |

**A+ SMC setups:**  
- Bullish structure + **discount**  
- Bearish structure + **premium**

### 5.3 Price Action (`priceAction.ts`)

Patterns scored:

- Bullish/Bearish **pin bar** (rejection wick)
- **Engulfing**
- **Inside bar** breakout
- 3-candle momentum sequence

**Role:** timing trigger on primary TF

### 5.4 Indicators (`indicators.ts`)

- **ATR(14)** — stop/target distance  
- **RSI(14)** — used in path prediction  
- **Classic pivots** from prior day:  
  `PP = (H+L+C)/3` · `R1 = 2·PP − L` · `S1 = 2·PP − H` · etc.  
- **Swing highs/lows** — structure + entry anchors

---

## 6. Confluence scoring (core signal formula)

Points added to **bullPts** or **bearPts**:

| Factor | Points |
|--------|--------|
| Primary MA trend | 18 |
| Confirm TF MA | 12 |
| Primary SMC structure | 22 |
| HTF SMC structure | 16 |
| Price action bias | 14 |
| EMA 9/21 crossover | 10 |
| BOS | 12 |
| CHoCH | 11 |
| Liquidity sweep (sell-side→bull / buy-side→bear) | 10 |
| Discount+bull or Premium+bear | 12 |

### Side decision

```
edge = |bullPts − bearPts|
minEdge = scalping ? 18 : 22

BUY  if bullPts > bearPts + minEdge
     AND HTF not fighting (SMC HTF ≠ BEARISH & confirm MA ≠ BEARISH)
     AND bullPts ≥ 45

SELL if bearPts > bullPts + minEdge
     AND HTF not fighting
     AND bearPts ≥ 45

else WAIT
```

### Confidence formula

```
rawConf =
  (max(bull,bear) / (bull+bear)) * 100 * 0.55
  + smc.score * 0.25
  + ma.score  * 0.12
  + pa.score  * 0.08

then:
  WAIT → confidence capped ≤ 58
  edge > 35 → +8 (cap 96)
  HTF SMC matches side → +6 (cap 97)
  final clamp [28, 97]
```

### Daily bias override

If daily bias is strongly opposite (confidence > 70) and no matching CHoCH → force **WAIT**.

---

## 7. Entry · SL · TP formulas (`buildLevels`)

### ATR used

```
atrRaw = ATR(14)
minPct = XAG 0.45% | XAU 0.18% | BTC 0.25%
atrFloor = price * minPct
atrVal = max(atrRaw, atrFloor)
```

### Multipliers

| | Scalping | Intraday |
|--|----------|----------|
| SL | 1.25 × ATR | 1.8 × ATR |
| TP1 | 1.5 × ATR | 2.2 × ATR |
| TP2 | 2.4 × ATR | 3.5 × ATR |
| TP3 | 3.5 × ATR | 5.0 × ATR |

### Entry (limit, not chase)

1. Prefer **order block mid** if available  
2. Else **swing low** (BUY) / **swing high** (SELL)  
3. Else offset from live: `price ± ATR×step`  
4. Sanity: SELL entry ≥ live; BUY entry ≤ live  

### Stops / targets

**BUY:**  
`SL = entry − atrVal×multSL` (also beyond OB/swing)  
`TP1/2/3 = entry + atrVal×tpNm`  
Enforce: `SL ≤ entry − atrFloor`

**SELL:**  
`SL = entry + atrVal×multSL`  
`TP1/2/3 = entry − atrVal×tpNm`  
Enforce: `SL ≥ entry + atrFloor`

```
R:R = |TP2 − entry| / |entry − SL|
```

---

## 8. Path prediction (From → To)

Uses HTF/daily SMC + MA + PA + RSI + classic pivots + ATR projection.

- Direction vote → BULLISH / BEARISH / NEUTRAL  
- **From / To** = projected path (e.g. 3980 → 3960 style)  
- **Win probability** ≈ confidence adjusted by confluence alignment  
- **Invalidation** = level that kills the path idea  

This panel is **guidance**, not the frozen trade ticket.

---

## 9. “AB RIGHT NOW” rules (`nowAction` + `tradeSafety`)

UI minimum confidence to act: **68%**  
Bot alert gates: **conf ≥ 70%** and **win ≥ 65%**

| Action | Meaning |
|--------|---------|
| WAIT_SETUP | No valid BUY/SELL plan |
| LOW_CONFIDENCE | Setup weak |
| WAIT_ENTRY | Plan locked — wait for price to reach entry |
| ENTER_NOW | Probe price inside entry zone + SL safe |
| TOO_LATE | Price already chewed risk / near SL — don’t chase |
| PLAN_DEAD | SL hit or plan cancelled |

### Entry zone

```
tol(Gold) ≈ 1.2–1.8
tol(Silver) ≈ 0.06–0.10
tol(BTC) ≈ 0.04–0.06% of price

SELL in zone if: entry−tol ≤ probe ≤ entry+1.2·tol
BUY  in zone if: entry−1.2·tol ≤ probe ≤ entry+tol
```

Probe = near live (**close/ask for SELL**, **close/bid for BUY**) — **not** day high.

### Too late

```
risk = |SL − entry|
SELL too late if live ≥ SL OR (live − entry) > 0.5 × risk
BUY  too late if live ≤ SL OR (entry − live) > 0.5 × risk
```

---

## 10. Frozen plan rules (important)

1. First valid BUY/SELL with conf ≥ 68 (UI) / 70 (bot) → **lock Entry/SL/TP**
2. Lock survives **page refresh** (browser `localStorage`) and bot `daemon/state.json`
3. Numbers do **not** change every tick
4. Change only if:
   - User clicks **New plan**
   - User switches asset or Scalp/Intraday
   - SL is hit
   - Plan marked TOO_LATE / unsafe → recycled

**If you already filled an older entry:** keep **your** broker SL/TP; ignore newer screen levels until you choose New plan.

---

## 11. Alerts

### Browser (tab open)

- Sound beeps when `ENTER_NOW`
- Optional Notification permission
- Service worker helps when tab is **hidden but not closed**

### Background bot (tab can be closed)

```bash
npm run alerts
```

Watches by default:

- XAUUSD intraday + scalping  
- XAGUSD intraday  
- BTCUSD scalping  

**Alert only if all true:**

1. `ENTER_NOW` + `inEntryZone`  
2. `confidence ≥ 70`  
3. `winProbability ≥ 65`  
4. Live near entry (not a distant fake fill)  
5. Same alert not repeated within 5 minutes  

Then: **Windows tray toast + 6 beeps**

---

## 12. How you should trade with this system (playbook)

1. Start UI (`npm run dev`) + optionally bot (`npm run alerts`)
2. Pick asset + **Scalp** or **Intraday**
3. Read **AB RIGHT NOW** only (Advanced is optional)
4. If **ENTRY WAIT** → place **limit** at locked Entry; do not chase live
5. Confirm price on **TradingView chart** before clicking broker
6. When **AB BUY/SELL LO** + alert → enter near locked Entry; use locked SL / TP1
7. Scale: TP1 partial → move SL to BE → TP2/TP3 optional
8. If **TOO_LATE / PLAN KHATAM** → no chase; wait New plan
9. Risk: never risk more than you accept per trade; this tool does not size lots for you

---

## 13. Known limitations

- Chart widget (OANDA/TVC) can still differ by a few ticks from scanner close — always confirm on chart
- Yahoo futures OHLC ≠ pure spot; system rebases to live quote
- Confidence / win % are **rule scores**, not proven expectancy
- Browser alone cannot alert if the tab process is fully closed — use `npm run alerts`
- Not a broker; no auto-execution

---

## 14. Quick formula cheat sheet

```
BUY/SELL  ← confluence edge + HTF align + daily bias OK
Entry     ← OB mid | swing | ATR offset (limit)
SL        ← entry ± max(ATR×mult, price×minPct)
TP1..3    ← entry ∓ ATR×tpMult
Conf%     ← weighted confluence + SMC/MA/PA scores
Win%      ← path model (ATR + pivots + RSI + SMC/MA)
ENTER_NOW ← probe in entry zone AND SL room safe AND conf OK
```

---

*Generated from codebase at `C:\scalping`. Update this report when formulas change.*
