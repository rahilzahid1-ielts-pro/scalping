/**
 * Shared JSON for GET /api/probeb/latest
 */
import { fetchMultiTimeframe } from "../services/marketData";
import {
  backtestProbebAccuracy,
  diagnoseProbeb,
  M5_MS,
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
  const recent = listRecentProbebDeduped(db, 24).map((r) => ({
    ...r,
    targetBarTime: r.barTime + M5_MS,
  }));

  let live: {
    side: "BUY" | "SELL";
    probabilityPct: number;
    confidencePct: number;
    bucket: string;
    sampleN: number;
    barTime: number;
    targetBarTime: number;
    quality: "strong" | "normal" | "weak";
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
        targetBarTime: diag.signal.targetBarTime,
        quality: diag.signal.quality,
        reason: diag.signal.reason,
      };
    } else {
      waitReason = diag.waitReason || "Probeb: history loading…";
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
