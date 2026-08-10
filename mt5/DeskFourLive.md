# DeskFourAutoEA (LIVE v1.10)

One MT5 EA for **QS Pro + Pro + Cipher B + Fractal**.

Does **not** change desk strategy rules — polls production locks and trades them:

| Module   | API                         | Magic    | Comment   |
|----------|-----------------------------|----------|-----------|
| QS Pro   | `/api/pulse/latest`         | 26072202 | `QSP:…`   |
| Pro      | `/api/pro/latest`           | 26072203 | `PRO:…`   |
| Cipher B | `/api/cipherbclone/latest`  | 26072204 | `CIB:…`   |
| Fractal  | `/api/fractal/latest`       | 26072205 | `FRA:…`   |

## Live checklist

1. Copy `DeskFourAutoEA.mq5` → `MQL5/Experts`, compile **F7** (open **only** this file — not QSPro project).
2. Tools → Options → Expert Advisors → allow WebRequest:  
   `https://scalping-production.up.railway.app`
3. **Hedging** account required.
4. Attach to **XAUUSD M5** (or broker suffix e.g. `XAUUSD.a` — leave `TradeSymbol` empty to use chart).
5. Inputs: `FixedLots=0.01`, Algo Trading ON.
6. **Remove** old `QSProAutoEA` / `MainIntradayAutoEA` from charts (magic clash).

## Live safety (v1.10)

- Max spread filter (`MaxSpreadUsd`)
- Broker min stop distance respected
- Stale OPEN lock skip (`MaxSignalAgeMinutes`)
- Filling mode auto (IOC/FOK/RETURN)
- Unique magic check
- Same ±$3 TP/SL + entry chase rules as prior single EAs
