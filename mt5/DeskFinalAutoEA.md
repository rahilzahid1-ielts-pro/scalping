# DeskFinalAutoEA (FINAL v1.03)

**ON:** QS Pro · Pro · Cipher B · Intra30  
**OFF (not in EA):** Scalp · Fractal · Quick Scalp · Intraday · Probeb

| Module   | Magic    | Comment | API |
|----------|----------|---------|-----|
| QS Pro   | 26072202 | `QSP:` | `/api/pulse/latest` |
| Pro      | 26072203 | `PRO:` | `/api/pro/latest` |
| Cipher B | 26072204 | `CIB:` | `/api/cipherbclone/latest` |
| Intra30  | 26072206 | `I30:` | `/api/intra30/latest` |

## v1.03 Cipher miss fix

- Fill detect = `executedAt` only (not `historyOpen`)
- `historyOpen` is just “History has an OPEN row” — treating it as filled forced late-market + permanent skip while price was still adversed → pending BuyStop/SellStop never placed
- Cipher `/latest` must include `executedAt` (null until zone touch)

## Install

1. MetaEditor → open **only** `DeskFinalAutoEA.mq5` → F7  
2. Remove from chart: DeskFour / QSPro / MainIntraday  
3. Attach **DeskFinalAutoEA** on XAUUSD M5 (hedging)  
4. Lots `0.01`, Algo Trading ON  
5. WebRequest allow: `https://scalping-production.up.railway.app`  
6. Experts log must show: `DeskFinalAutoEA v1.03`  
7. VPS: migrate after attach
