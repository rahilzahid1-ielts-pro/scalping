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
  type ProbebRow,
} from "./store";

function qualityFromReason(reasonJson: string): "strong" | "normal" | "weak" {
  let note = "";
  try {
    const arr = JSON.parse(reasonJson) as unknown;
    if (Array.isArray(arr) && typeof arr[1] === "string") note = arr[1];
  } catch {
    note = reasonJson;
  }
  if (/^STRONG/i.test(note)) return "strong";
  if (/^Normal/i.test(note)) return "normal";
  return "weak";
}

function reasonList(reasonJson: string): string[] {
  try {
    const arr = JSON.parse(reasonJson) as unknown;
    if (Array.isArray(arr)) return arr.map(String);
  } catch {
    /* plain */
  }
  return reasonJson ? [reasonJson] : [];
}

function liveFromLocked(row: ProbebRow) {
  return {
    side: row.predictedSide,
    probabilityPct: row.probabilityPct,
    confidencePct: row.confidencePct,
    bucket: row.bucket,
    sampleN: row.sampleN,
    barTime: row.barTime,
    targetBarTime: row.barTime + M5_MS,
    quality: qualityFromReason(row.reason),
    reason: reasonList(row.reason),
  };
}

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

  // Prefer DB-locked lean for this M5 so hero doesn't flip BUY↔SELL every poll
  // when HTF/Yahoo resync rewrites the last closed bar.
  if (synced.locked) {
    live = liveFromLocked(synced.locked);
    waitReason = null;
  } else if (synced.signal) {
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
    live: live
      ? {
          ...live,
          levels: synced.levels,
        }
      : null,
    latest,
    today,
    lifetime,
    walkAccuracy,
    recent,
    waitReason,
    levels: synced.levels,
    synced: {
      resolved: synced.resolved,
      inserted: Boolean(synced.inserted),
      livePrice: synced.livePrice,
      closedBars: synced.primary.length,
      locked: Boolean(synced.locked),
    },
    autoTrade: synced.autoTrade,
  };
}
