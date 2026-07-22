/**
 * Ensure each module latest API `latest` field matches History OPEN when one exists.
 */
import { getActiveOpenLock, type ActiveOpenLock } from "./activeLock";
import type { ActiveModuleId } from "./moduleIds";

/** Keep resolved TP1/SL visible briefly so UI can clear EXIT alerts (not "lock revoked"). */
const RESOLVED_UI_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * OPEN always; recent TP1_HIT/SL_HIT also shown so clients do not treat a clean
 * TP resolve as a mysterious lock revoke (false EXIT ALERT).
 */
export function selectUiLatest<
  T extends {
    outcome: string;
    resolvedAt?: number | null;
    timestamp?: number;
    time?: number;
  },
>(candidate: T | null, now = Date.now()): T | null {
  if (!candidate) return null;
  if (candidate.outcome === "OPEN") return candidate;
  if (candidate.outcome === "TP1_HIT" || candidate.outcome === "SL_HIT") {
    const at =
      candidate.resolvedAt ?? candidate.timestamp ?? candidate.time ?? 0;
    if (at > 0 && now - at <= RESOLVED_UI_TTL_MS) return candidate;
  }
  return null;
}

export function withHistoryOpenLatest<T extends { outcome: string }>(
  module: ActiveModuleId,
  latest: T | null,
  fromOpen: (open: ActiveOpenLock) => T,
): T | null {
  const open = getActiveOpenLock(module);
  if (open) return fromOpen(open);
  return latest;
}
