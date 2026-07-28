# SMC Scalping Desk — Full Project Report (PM Handoff)

**Audience:** Project Manager (Claude)  
**Repo:** `C:\scalping` → Railway production (`scalping-production.up.railway.app`)  
**Asset focus (live desks):** XAUUSD (Gold). UI historically also supports Silver / BTC.  
**Date of this report:** 28 Jul 2026  
**Latest commits:** `23d7d30` (trend runner) · `227ff37` (same-side SL guards) · `2884da4` / `d3b451f` (chase / post-TP)

**Disclaimer:** Educational / paper (demo) signal system — not financial advice.

---

## 0. One-paragraph summary

This is a multi-desk gold scalping portal: React UI + Node production server + isolated strategy bots, SQLite history, a day-adaptive regime layer, an ML SL-risk overlay (weekly retrain), a paper demo account with auto-follow, and (as of 28 Jul) a measured **trend runner exit** so winning trades can return more than ~0.85R. The live problem through late July was **not “too few ideas”** — it was **same-side stacking into one daily bias** (many SELL SLs) plus **hard-capped exits** that left most of a $64 down-move on the table. Those two failure modes are what the last updates target.

---

## 1. What the product does

1. Pulls live OHLC / quotes (TradingView scanner + Yahoo/Binance candles, rebased to live).
2. Runs several **independent strategy modules** (each with its own bot + SQLite table).
3. Locks Entry / SL / TP when a setup passes module gates + day-regime + learned overlay.
4. Shows History, Demo paper account, ML status, Push/Telegram alerts.
5. Demo can **auto-follow** prefer modules; exits now use a **runner** in trend regimes.

**Product goal (workspace rule):** green account days with **real fills** — not a silent desk that avoids trades.

---

## 2. Architecture (how the pieces connect)

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (Vite React)                                            │
│  App.tsx → module cards, chart, History, Demo, LearnStatus, Push │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTPS /api/*
┌───────────────────────────────▼─────────────────────────────────┐
│  server/prodServer.ts                                            │
│  - static dist/                                                  │
│  - history / demo / learn / push / pulse / cipher / … APIs       │
│  - boots workers: alert, QS, Pro, Intra30, Pulse, Cipher,        │
│    Fractal, weeklyLearn, demoRunner                              │
└───────┬─────────────┬─────────────┬─────────────┬───────────────┘
        │             │             │             │
   strategy      day regime     learn ML      demo account
   engines +     dayModuleRules gateLearned   engine + store
   bots          + positiveDay  Lock          + exitPolicy
        │             │             │             │
        └─────────────┴─────────────┴─────────────┘
                          │
                    data/signals.db  (+ learn artifacts on volume)
```

**Persistence (Railway):**
- Volume mount: `/app/data` → `signals.db`, learn labels, demo tables.
- `learn-seed/` lives **outside** the volume; on boot `ensureLearnSeeded()` copies missing model files into `data/learn/` (volume was hiding git-tracked files).

**Timeframes before lock (prod rule):**
| Family | Entry | Confirm | Bias | Daily |
|--------|-------|---------|------|-------|
| Scalping (Scalp, QS Pro, Cipher, Fractal, Quick Scalp, Intra30) | M5 | M15 | H1 | D1 |
| Intraday / Pro | M15 | H1 | H4 | D1 |

---

## 3. Module-by-module: how each desk works

### 3.1 Shared core — `signalEngine` / SMC

- **File:** `src/strategies/signalEngine.ts` (+ `smartMoney.ts`, `movingAverages.ts`, `priceAction.ts`)
- Most desks wrap `generateSignal()` on scalping or intraday frames.
- Outputs: side BUY/SELL/WAIT, levels (entry/SL/TP), confidence, regime (`TREND_UP` / `TREND_DOWN` / `RANGE`…), daily bias, confluence reasons.
- **Daily agree filter** (`src/utils/entryFilters.ts`): BUY only if D1 BULLISH; SELL only if D1 BEARISH. This forces all desks onto one side on a biased day — important for the Jul SL autopsy (see §5).

### 3.2 Scalp (alertBot / classic desk)

- **Bot:** `daemon/alertBot.ts`
- Classic SMC lock desk (browser + Telegram / Web Push).
- **Day regime:** demoted base — not a daily driver.
- **Demo:** **never** auto-follow (hard rule).
- Uses chase filters from `entryFilters` in places; not prefer-base.

### 3.3 QS Pro (Pulse) — primary prefer desk

- **Engine:** `src/strategies/pulseEngine.ts`  
- **Bot / store / API:** `daemon/pulseBot.ts`, `src/pulse/*`
- **Formula:**
  - SMC `generateSignal` on scalping TFs
  - Prefer **Fractal direction agree** with SMC
  - If no fractal: **SMC conf ≥ 85** **and** `hasFreshExtreme` (fresh 2h directional extreme) — tightened 28 Jul after SL on lagging MAs
  - Daily bias agree + `leanDeskEntryBlock` (chase + bounce)
  - Levels: TP1 **0.85R**, TP2 **1.5R** (plan levels; demo runner may scale differently — §6)
- **Day regime:** prefer-base; demo auto-follow yes
- **Isolated** from alertBot / Pro / Quick Scalp locks

### 3.4 Cipher B

- **Engine:** `src/strategies/cipherBLive.ts`
- WaveTrend Cipher-B trigger **must agree** with SMC; `MIN_CONF = 72`
- TP1 **0.9R**, TP2 **1.6R**
- **Day regime:** prefer-base; demo follow yes
- Accuracy over frequency (fires less than QS Pro)

### 3.5 Pro

- **Engine:** `src/strategies/proEngine.ts`
- Strict filter over `generateSignal` on **intraday** path; `PRO_MIN_CONFIDENCE = 80`
- Prefer-base for day regime / lean-family post-TP (included so QS Pro TP blocks Pro re-short)
- Demo follow yes; rarer fills

### 3.6 Quick Scalp (BLITZ)

- **Engine:** `src/strategies/quickScalpEngine.ts`
- SMC + trend gates; fast bank TP1 **0.85R** / TP2 **1.5R**; conf floor ~75
- **Day regime:** demoted until proven green; demo candidate but gated by tier
- Isolated table/bot

### 3.7 Fractal (TTrades)

- **Engine:** `src/strategies/fractalLive.ts`
- Fractal breakout **must agree** SMC; same lean entry filters as QS Pro
- TP1 **0.9R**, TP2 **1.6R**
- Live OK; **no demo follow** (same-print double risk with QS Pro)
- In lean family for post-TP / chase / retrace guards

### 3.8 Intra30

- **Engine:** `src/strategies/intra30Engine.ts`
- Strong M5 candle (body ≥90%, wick ≤5%) → next open; H1 + Daily same color; 2h chase block
- Fixed dollar distances: SL **$5**, TP1 **$3**, TP2 **$6** (not R-multiple based)
- Cooldowns: post-resolve ~25m; opposite fade block ~30m
- Demo follow when tier allows; not prefer-base

### 3.9 Intraday (classic)

- Uses SMC on intraday TFs via alert / calibration path
- Demo candidate; lower risk mult (~0.85×) when allowed

### 3.10 Archived / measurement engines

- `archived/cipherBSignal`, `fractalSignal`, `ictSignal` — building blocks / compare
- `strongCandleEngine`, `trendBurstEngine` — helpers / experiments
- `strategyCompare` — Cipher/Fractal compare cards + store

---

## 4. Cross-cutting systems

### 4.1 Day-adaptive module regime — `src/regime/dayModuleRules.ts`

**Purpose:** “jo aaj jeet raha usko zyada” without silencing the desk.

| Concept | Behavior |
|---------|----------|
| Prefer base | `qs_pro`, `cipher_b`, `pro` |
| Demote base | `scalp`, `quick_scalp` |
| Lean family | `qs_pro`, `cipher_b`, `quick_scalp`, `fractal`, `pro` — shared post-TP / chase / retrace |
| Per-module SL | Prefer: 2 SL → soft throttle (still fires); 3 SL → hard pause. Others: 2 SL → pause |
| Day WR confidence | After ≥3 executed fills: ≥70% boost; 60–70% normal; &lt;60% no new locks / no demo for that module |
| Weekend | Fri 20:00 PKT → Mon open: no new locks |
| Sell-lean day | Block Scalp BUY |
| Gate entry | `gateNewLock` / `gateNewLockFromSnapshot` (+ `gateLearnedLock`) |

**Same-side stacking guards (added / tightened 27–28 Jul):**

| Guard | Rule |
|-------|------|
| Post-TP pause | 90m same-side across lean family after a TP |
| Chase-after-TP | Block if new entry ≥ **$8** past last lean TP entry (3h) |
| Retrace-after-TP | Block if entry pulled ≥ **$3** back past that TP entry (3h) — stops “wait out the pause then fade the bounce” |
| Day side-stop (`sideRisk`) | Count same-side SLs **across all modules**: 2 → prefer-only + 2h cooldown; 3 → that side banned for the day; opposite side stays open |
| Bounce (`isCounterBounce`) | Block when price is **$10+** off 2h extreme and short-term momentum flipped (QS Pro / Fractal via `leanDeskEntryBlock`) |
| QS Pro no-fractal | Conf ≥85 + `hasFreshExtreme` |

### 4.2 Positive-day desk — `src/regime/positiveDayDesk.ts`

Demo equity rails on **closed** day R:

| Rail | Effect |
|------|--------|
| Day stop **−3R** | No new auto-follows |
| Day protect **+3R** | Only prefer modules @ 0.75× |
| Day lock **+5R** | Stop new follows (bank the green) |

### 4.3 Learn / ML overlay — `src/learn/*`

- Trains SL-risk model from live CSV fills + long OHLC backtest labels (`labeled_20y`).
- Weekly merge: Sunday ~22:00 PKT (`ENABLE_WEEKLY_LEARN=auto` on Railway); sanity-gated overwrite — **no daily full-ML cron** (overfit risk).
- Runtime: `gateLearnedLock` inside `gateNewLock`.
- UI: `LearnStatusCard` + `/api/learn/status` (model loaded, weekly stamp, day confidence, seed copy status).
- Seed: `learn-seed/` → `data/learn/` on boot.

### 4.4 History — `src/history/apiHistory.ts`

- Unifies rows from scalp/intraday signals + QS / Pulse / Pro / Intra30 / Cipher / Fractal stores.
- EXECUTED vs NOT EXECUTED (zone touch), outcomes, realized R, money fields, **regime** (for demo runner ladder choice).

### 4.5 Demo account — `src/demoAccount/*`

- Paper account in `signals.db` (`demo_accounts`, `demo_positions`, `demo_ledger`).
- Risk from **starting** balance × riskPct (default start $2000).
- Auto-follow prefer / allowed modules when budget + regime allow; never Scalp / Fractal.
- Sync from history + price resolve.
- **Exit policy** (see §6): trend runner vs full close at TP1.

### 4.6 Notifications

- Telegram (alert worker) + Web Push (VAPID, `data/push-subscriptions.db`).
- UI: Push ON/OFF toggle + explicit Push OFF + Test Push.
- Theme: light/dark (`data-theme`, `useTheme`).

### 4.7 Calibration / outcomes

- `src/calibration/resolveOutcomes.ts` — live signal TP1 vs SL; after TP1 track TP2/TP3 vs BE stop for logged plans.
- Demo runner is a **separate** measured path (`exitPolicy`) so paper P&amp;L can exceed plan TP1.

---

## 5. SL problem autopsy (what broke, what we fixed)

### 5.1 Observed live stats (24–28 Jul, executed)

| Metric | Value |
|--------|-------|
| Executed | ~20 |
| SELL / BUY | **18 / 2** |
| SL / TP | **13 / 7** → ~**35%** live WR |
| QS Pro | 5 SL vs 3 wins |
| QS Pro backtest badge | ~87% WR (huge live gap) |

### 5.2 Failure A — Same-side stacking (architecture)

**Cause:** `dailyAgreesWithSide` + daily BEARISH forced every desk to only SELL. Per-module SL counters alone were not enough — six desks became **one correlated bet**. After a Cipher SELL TP, QS Pro re-sold into the bounce the moment the time pause expired.

**Concrete 28 Jul example:**
- Cipher B SELL @ 4029.31 → TP1 ~18:44 PKT  
- QS Pro SELL @ 4032.72 @ 20:14 (exactly after ~90m pause) — **no fractal**, SMC-strong fallback on lagging MAs while gold was rallying  
- SL @ 4041.79  

Chase-after-TP ($8 past TP entry) did **not** fire: entry was **above** the TP entry (bounce fade), not below (chase lower).

**Fixes shipped:**
1. Post-TP pause 90m lean family (incl. Pro)  
2. Chase-after-TP $8 / 3h  
3. Retrace-after-TP $3 / 3h (blocks bounce re-entry past winning entry)  
4. Day side-stop across modules  
5. Bounce guard $10+ off extreme + momentum flip  
6. QS Pro fallback: conf ≥85 + fresh extreme  

Commits: `d3b451f`, `2884da4`, `227ff37`.

### 5.3 Failure B — Trend opportunity not harvested (exits)

**Cause:** Every desk capped ~0.85–1.5R; demo closed **100% at TP1** and ignored TP2. On 27–28 Jul gold ran ~**$64** in the allowed SELL direction; book still finished ~**−1.6R**. Also a long quiet window with few/no signals while price continued (entry filters + correlation — separate from exit cap).

**Fix shipped (`23d7d30`):** measured trend runner — see §6.

### 5.4 What is intentionally NOT fixed yet

- **Daily-bias staleness** (treat D1 BEARISH as NEUTRAL when H1 flips / price runs opposite $X) — invasive; deferred.
- **Regime-aware `isExtendedChase`** / continuation re-entry in trends — would open more of the mid-trend leg but raises SL risk; deferred until runner proves out live.
- **Gate-rejection logging** — blackouts are still hard to diagnose from history alone (WAIT reasons not persisted).

---

## 6. Last major update — Trend runner (demo exits)

### 6.1 Policy (`src/exits/exitPolicy.ts`)

Live policy id: **`runner_trail_peak`**

| Regime | Behavior |
|--------|----------|
| **Trend** (`regime` contains `TREND`) | Bank **30% at 1R** → stop to **breakeven** → trail remaining **70%** at **0.5R** behind best favourable price |
| **Range** | Bank **100% at 0.85R** (old behaviour) |

Why peak trail (not swing bars): live demo resolver only has a polled price, not a full M5 window on every tick. Peak trail was measured to match swing trail closely.

### 6.2 Backtest evidence (same QS Pro signal set)

| Window | Old `fixed_tp1` total R | Runner total R | Lift | Max DD change |
|--------|-------------------------|----------------|------|---------------|
| 180d | 101.7 | 142.9 | **+40%** | −4.2 → −4.2 |
| 365d | 210.7 | 289.6 | **+37%** | −5.3 → −5.8 |
| 730d | 423.7 | 577.1 | **+36%** | −5.3 → −6.0 |
| 1460d | 751.7 | 1009.9 | **+34%** | −10.3 → −11.1 |

- Every cell in the tune grid beat baseline (not knife-edge).
- Wider trails looked better on short windows but on 1460d returned similar R with much worse DD (−22R) → **0.5R** chosen.
- Live tick machine vs walk-forward: **−0.85%** drift / 540 trades (`npm run backtest:exits:parity`).

### 6.3 Production wiring

- Demo positions store: `regime`, `policy`, `stopNow`, `partsClosed`, `bankedR`, `bankedUsd`, `peakPrice` (+ SQLite `ALTER` migration for existing volumes).
- Partial banks credit the ledger immediately; UI floating P&amp;L only on **open fraction** (no double-count).
- Source history TP1 **does not** force-close a runner (price resolver owns exit); invalidations still close.
- `daemon/demoRunnerBot.ts` polls price every **60s** so trails work with UI closed (`ENABLE_DEMO_RUNNER=0` to disable).
- Positions opened **before** the runner keep `policy = null` → finish as `fixed_tp1`.

### 6.4 Scripts

```bash
npm run backtest:exits          # policy comparison
npm run backtest:exits:sweep    # tune grid
npm run backtest:exits:pick     # peak trail distance across windows
npm run backtest:exits:parity   # tick machine vs bar simulator
npm run demo-runner             # standalone runner worker
```

---

## 7. Other recent product updates (UI / ops)

| Area | Change |
|------|--------|
| ML visibility | Learn status card above chart; seed status; weekly info |
| Railway learn | `learn-seed/` boot copy so LIVE GATE works after volume mount |
| Theme | Light / dark toggle (`data-theme`) |
| Demo UI | Prominent open-trade cards, readable light mode |
| History | SaaS-style filter toolbar |
| UX | Hide “New plan” on History & Demo; remove Gold asset tab |
| Push | Explicit ON/OFF + Push OFF button |

---

## 8. Prefer / demote / demo matrix (quick reference)

| Module | Prefer | Demo auto-follow | Lean family | Typical RR (plan) |
|--------|--------|------------------|-------------|-------------------|
| QS Pro | Yes | Yes | Yes | 0.85 / 1.5 |
| Cipher B | Yes | Yes | Yes | 0.9 / 1.6 |
| Pro | Yes* | Yes | Yes | stricter intraday |
| Quick Scalp | No (demote) | Tier-gated | Yes | 0.85 / 1.5 |
| Fractal | No | **Never** | Yes | 0.9 / 1.6 |
| Intra30 | No | Tier-gated | No | $3 / $5 / $6 |
| Scalp | No (demote) | **Never** | No | SMC plan |
| Intraday | No | Tier-gated | No | SMC plan |

\*Pro is prefer-base for firing/lean cooldowns; tier text may still say “measurement / rare” in places.

---

## 9. Key files for a PM / reviewer

| Path | Role |
|------|------|
| `.cursor/rules/day-module-regime.mdc` | Canonical product rules (always apply) |
| `src/regime/dayModuleRules.ts` | Day tiers + same-side gates |
| `src/regime/positiveDayDesk.ts` | Demo day stop/protect/lock |
| `src/utils/entryFilters.ts` | Daily agree, chase, bounce, fresh extreme |
| `src/strategies/pulseEngine.ts` | QS Pro |
| `src/exits/exitPolicy.ts` | Measured exit policies + live tick runner |
| `src/demoAccount/engine.ts` | Demo open / runner resolve / close |
| `daemon/demoRunnerBot.ts` | Background price poll for runners |
| `src/learn/*` | ML train / gate / seed / status |
| `server/prodServer.ts` | API + worker boot |
| `data/signals.db` | Live + demo persistence (Railway volume) |

---

## 10. Ops checklist (Railway)

- Volume on `/app/data`
- Workers: Pulse / Cipher / Pro / Intra30 / Fractal / Alert / Weekly learn / Demo runner (defaults documented per env)
- Telegram / Web Push VAPID as needed
- Do **not** remove day-regime or positive-day without explicit request
- Do **not** put Scalp back on demo auto-follow
- Do **not** replace autopsy rules with opaque ML-only gating

---

## 11. Open risks / next decisions for PM

1. **Live WR still vs backtest:** stacking guards + runner address known failure modes; live WR must be remeasured over next green week.
2. **Daily bias single-direction force** remains the root diversification illusion — staleness rule is the next structural debate.
3. **Trend continuation entries** (loosen chase in confirmed trends) trade more of the mid-move but risk new SL clusters — only after runner live data.
4. **Demo risk %** was observed at 3% on ~$1800 equity in one session — sizing is a separate risk conversation from architecture.
5. **Scalp appearing on demo** in recent closed list should be audited (rule says never auto-follow — may be manual / old row).

---

## 12. Suggested PM one-liner

> Multi-desk gold portal with day-regime + ML overlay; late-July live damage was same-side SELL stacking and TP1-capped exits. Shipped same-side guards (side-stop, bounce, retrace) and a measured trend runner (+34–40% R on multi-year QS Pro replay) on demo exits; daily-bias staleness and trend-continuation entries are the next architectural choices.

---

*End of report — generated for PM handoff, 28 Jul 2026.*
