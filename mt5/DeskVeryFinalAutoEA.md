# DeskVeryFinalAutoEA v2.00

**One EA. Portal SL/TP. Fast entry. Fractal included.**

## ON
| Module | Magic | Comment | API |
|--------|-------|---------|-----|
| QS Pro | 26072202 | `QSP:` | `/api/pulse/latest` |
| Pro | 26072203 | `PRO:` | `/api/pro/latest` |
| Cipher B | 26072204 | `CIB:` | `/api/cipherbclone/latest` |
| Fractal | 26072205 | `FRA:` | `/api/fractal/latest` |
| Intra30 | 26072206 | `I30:` | `/api/intra30/latest` |

## OFF (not in EA)
Scalp · Quick Scalp · Intraday · Probeb

## Behavior
- **SL/TP = portal `sl` + `tp1`** (`UsePortalStops=true`) — not fixed $3
- Fixed $3 only if API levels missing/invalid
- Poll every **2s** + tick poll **1.5s** (timely)
- No permanent skip on one chase spike
- `historyOpen` treated as EXECUTED (Cipher/Fractal)

## Install
1. Remove old EAs from chart (DeskFinal / DeskFour / QSPro / MainIntraday)
2. MetaEditor → open **only** `DeskVeryFinalAutoEA.mq5` → **F7**
3. Attach XAUUSD **M5** hedging · Algo ON · lot `0.01`
4. WebRequest allow: `https://scalping-production.up.railway.app`
5. VPS migrate after attach

Experts log must show: `DeskVeryFinalAutoEA v2.00` and `stops=PORTAL`
