/**
 * Shared JSON for GET /api/probeb/latest
 */
import { fetchMultiTimeframe } from "../services/marketData";
import {
  backtestProbebAccuracy,
  generateProbebPrediction,
} from "../strategies/probebEngine";
import { karachiYmd } from "../history/apiHistory";
import {
  dayAccuracy,
  getLatestProbeb,
  getLiveProbebDb,
  lifetimeAccuracy,
  listRecentProbeb,
} from "./store";

export async function buildProbebLatestPayload() {
  const db = getLiveProbebDb();
  const latest = getLatestProbeb(db);
  const todayKey = karachiYmd(Date.now());
  const today = dayAccuracy(db, todayKey);
  const lifetime = lifetimeAccuracy(db);
  const recent = listRecentProbeb(db, 15);

  let live: {
    side: "BUY" | "SELL";
    probabilityPct: number;
    confidencePct: number;
    bucket: string;
    sampleN: number;
    barTime: number;
    reason: string[];
  } | null = null;
  let walkAccuracy: {
    resolved: number;
    correct: number;
    accuracyPct: number | null;
  } | null = null;
  let waitReason: string | null = null;

  try {
    const frames = await fetchMultiTimeframe("XAUUSD", "scalping", undefined, {
      rebaseToLive: true,
    });
    const pred = generateProbebPrediction(frames);
    if (pred) {
      live = {
        side: pred.side,
        probabilityPct: pred.probabilityPct,
        confidencePct: pred.confidencePct,
        bucket: pred.bucket,
        sampleN: pred.sampleN,
        barTime: pred.barTime,
        reason: pred.reason,
      };
    } else {
      waitReason = "Probeb: history short — M5 bars kam hain";
    }
    walkAccuracy = backtestProbebAccuracy(frames);
  } catch (e) {
    waitReason = e instanceof Error ? e.message : "market fetch failed";
  }

  return {
    ok: true as const,
    module: "probeb",
    live,
    latest,
    today,
    lifetime,
    walkAccuracy,
    recent,
    waitReason: live ? null : waitReason,
  };
}
