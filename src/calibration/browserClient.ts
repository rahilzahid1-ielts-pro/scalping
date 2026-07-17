import type { LiveSignal } from "../types";

/** Browser → Vite calibration API (persists to data/signals.db via Node middleware) */
export async function logSignalViaApi(signal: LiveSignal): Promise<void> {
  if (signal.side === "WAIT" || !signal.levels || !signal.diagnostics) return;
  const d = signal.diagnostics;
  try {
    await fetch("/api/calibration/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: signal.asset,
        mode: signal.mode,
        side: signal.side,
        entry: signal.levels.entry,
        sl: signal.levels.stopLoss,
        tp1: signal.levels.takeProfit1,
        tp2: signal.levels.takeProfit2,
        tp3: signal.levels.takeProfit3,
        confidence: signal.confidence,
        winChanceDisplayed: signal.rangePrediction.winProbability,
        confluencePct: d.confluencePct,
        smcScore: d.smcScore,
        maScore: d.maScore,
        paScore: d.paScore,
        bullPts: d.bullPts,
        bearPts: d.bearPts,
        htfAligned: d.htfAligned,
        dailyBias: signal.dailyBias.bias,
        conflictingSignals: d.conflictingSignals,
        conflictCapped: d.conflictCapped,
        atr14: d.atr14,
        atrPctOfPrice: d.atrPctOfPrice,
        regime: d.regime,
        timestamp: signal.timestamp,
      }),
    });
  } catch {
    /* offline / API down — measurement best-effort */
  }
}

export async function resolveSignalsViaApi(
  symbol: string,
  price: number,
  extra?: { open?: number; high?: number; low?: number },
): Promise<void> {
  try {
    await fetch("/api/calibration/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, price, ...extra }),
    });
  } catch {
    /* ignore */
  }
}
