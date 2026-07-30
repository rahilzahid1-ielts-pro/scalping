/**
 * Shared JSON for GET /api/probeb/latest
 */
import { backtestProbebAccuracy, M5_MS } from "../strategies/probebEngine";
import { karachiYmd } from "../history/apiHistory";
import { syncProbebLive } from "./syncLive";
import {
  dayAccuracy,
  getLatestProbeb,
  getLiveProbebDb,
  lifetimeAccuracy,
  listRecentProbebDeduped,
} from "./store";

export async function buildProbebLatestPayload() {
  // UI poll drives resolve + insert (Yahoo M5 alone is too laggy for GC=F).
  const synced = await syncProbebLive();

  const db = getLiveProbebDb();
  const latest = getLatestProbeb(db);
  const todayKey = karachiYmd(Date.now());
  const today = dayAccuracy(db, todayKey);
  const lifetime = lifetimeAccuracy(db);
  const recent = listRecentProbebDeduped(db, 36).map((r) => ({
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
  let waitReason: string | null = synced.waitReason || null;

  if (synced.signal) {
    live = {
      side: synced.signal.side,
      probabilityPct: synced.signal.probabilityPct,
      confidencePct: synced.signal.confidencePct,
      bucket: synced.signal.bucket,
      sampleN: synced.signal.sampleN,
      barTime: synced.signal.barTime,
      targetBarTime: synced.signal.targetBarTime,
      quality: synced.signal.quality,
      reason: synced.signal.reason,
    };
    waitReason = null;
  } else if (!waitReason) {
    waitReason = "Probeb: history loading…";
  }

  try {
    walkAccuracy = backtestProbebAccuracy({
      primary: synced.primary,
      confirmation: [],
      bias: [],
    });
  } catch {
    walkAccuracy = null;
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
    synced: {
      resolved: synced.resolved,
      inserted: Boolean(synced.inserted),
      livePrice: synced.livePrice,
      closedBars: synced.primary.length,
    },
  };
}
