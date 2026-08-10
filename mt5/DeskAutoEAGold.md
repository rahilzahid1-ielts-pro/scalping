# DeskAutoEAGold v2.02

Gold desk auto-trader for MetaTrader 5. Portal locks → MT5 fills with **portal SL/TP1** (not fixed $3).

## ON
| Module | Magic | Comment | API |
|--------|-------|---------|-----|
| QS Pro | 26072202 | `QSP:` | `/api/pulse/latest` |
| Pro | 26072203 | `PRO:` | `/api/pro/latest` |
| Cipher B | 26072204 | `CIB:` | `/api/cipherbclone/latest` |
| Fractal | 26072205 | `FRA:` | `/api/fractal/latest` |
| Intra30 | 26072206 | `I30:` | `/api/intra30/latest` |

## OFF (not in this EA)
Scalp · Quick Scalp · Intraday · Probeb

## Behavior
- **SL/TP = portal `sl` + `tp1`** (`UsePortalStops=true`)
- Fixed `$3` only if API levels missing/invalid
- Fast poll (**1s**) + tick poll (**0.8s**)
- Join if live still inside portal SL..TP1 band
- Fill detect = **`executedAt` only** (not `historyOpen`)
- Unique magic + comment per module

## Install
1. Copy `DeskAutoEAGold.mq5` → `MQL5/Experts`
2. MetaEditor → open **only** this file → **F7**
3. Remove other desk EAs from the chart
4. Attach on **XAUUSD M5** (hedging account)
5. Inputs: `FixedLots=0.01`, Algo Trading ON
6. WebRequest allow: `https://scalping-production.up.railway.app`
7. VPS: migrate after attach

Experts log must show: `DeskAutoEAGold v2.02` and `stops=PORTAL`
