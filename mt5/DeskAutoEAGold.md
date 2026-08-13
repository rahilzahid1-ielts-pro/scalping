# DeskAutoEAGold v2.04

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
- Fresh tick gate — avoids VPS stale bid/ask skips
- OnInit **API SELF-TEST** — must print `OK` or every lock will be missed

## Install
1. Copy `DeskAutoEAGold.mq5` → `MQL5/Experts`
2. MetaEditor → open **only** this file → **F7**
3. Remove **DeskVeryFinal / DeskFour / DeskFinal** from the chart
4. Attach on **XAUUSD M5** (hedging account)
5. Inputs: `FixedLots=0.01`, `UsePortalStops=true`, **`EnableFractal=true`**, Algo Trading ON
6. WebRequest allow: `https://scalping-production.up.railway.app`
7. VPS: **Migrate** after attach (local chart change does nothing on host)

Experts log must show:
- `DeskAutoEAGold v2.04` + `stops=PORTAL`
- `API SELF-TEST OK`
- `ON:` including `CipherB` and `Fractal` (if you want Fractal)

## If trades miss again
| Log line | Meaning |
|----------|---------|
| `API SELF-TEST FAIL` / `API HTTP 1003` / `4014` | Portal unreachable — URL allow-list or VPS network |
| `EnableFractal=false` / ON line without Fractal | Fractal locks ignored on purpose |
| No VPS Experts log today | Hosting stopped or EA not migrated |
| `JOIN` / `MARKET` / `PENDING` | EA saw lock and fired (good) |

## Do not confuse
Journal `signal disabled` = MQL5 Signals off (normal). It is **not** Algo Trading.
