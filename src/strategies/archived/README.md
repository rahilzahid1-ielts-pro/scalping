# Strategy engines — live dual-confirm + archived raw

## Live tabs (accuracy pack)

| Tab | Trigger | Gate | 1y M5 result |
|-----|---------|------|--------------|
| **Cipher B** | WaveTrend Cipher-B clone | Must agree with SMC (conf≥72, HTF, trend, daily) | ~83% TP1 / +0.58R |
| **TTrades Fractal** | Bill Williams fractal breakout | Same SMC dual-confirm | ~90% TP1 / +0.72R |

Raw archived engines alone were ~**47%** — live wrappers only fire when SMC agrees.

## Still retired

| Strategy | Why |
|----------|-----|
| ICT | n=3, 0% win |

Archived raw: `cipherBSignal.ts`, `fractalSignal.ts`, `ictSignal.ts`.

Bots: `npm run cipherb` / `npm run fractal` (Railway: `ENABLE_CIPHER_B_WORKER` / `ENABLE_FRACTAL_WORKER`).
