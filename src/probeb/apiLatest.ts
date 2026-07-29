/**
 * Shared JSON for GET /api/probeb/latest
 */
import { fetchMultiTimeframe } from "../services/marketData";
import {
  backtestProbebAccuracy,
  diagnoseProbeb,
} from "../strategies/probebEngine";
import { karachiYmd } from "../history/apiHistory";
import {
  dayAccuracy,
  getLatestProbeb,
  getLiveProbebDb,
  lifetimeAccuracy,
  listRecentProbebDeduped,
} from "./store";

export async function buildProbebLatestPayload() {
  const db = getLiveProbebDb();
  const latest = getLatestProbeb(db);
  const todayKey = karachiYmd(Date.now());
  const today = dayAccuracy(db, todayKey);
  const lifetime = lifetimeAccuracy(db);
  const recent = listRecentProbebDeduped(db, 20);

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
    const diag = diagnoseProbeb(frames);
    if (diag.signal) {
      live = {
        side: diag.signal.side,
        probabilityPct: diag.signal.probabilityPct,
        confidencePct: diag.signal.confidencePct,
        bucket: diag.signal.bucket,
        sampleN: diag.signal.sampleN,
        barTime: diag.signal.barTime,
        reason: diag.signal.reason,
      };
    } else {
      waitReason = diag.waitReason || "Probeb: no clear next-candle edge";
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
    waitReason,
  };
}
