/**
 * Phone/local paint cache for module locks.
 * Survives Railway redeploys that wipe empty (no-volume) SQLite.
 * Not authority — server `latest` always wins when present.
 */
const PREFIX = "go_lock_cache_v1:";

export interface CachedLock {
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  outcome: string;
  time: number;
  reason?: string;
  metaExtra?: Record<string, unknown>;
}

export function loadCachedLock(moduleKey: string): CachedLock | null {
  try {
    const raw = localStorage.getItem(PREFIX + moduleKey);
    if (!raw) return null;
    const v = JSON.parse(raw) as CachedLock;
    if (!v || (v.direction !== "BUY" && v.direction !== "SELL")) return null;
    if (!Number.isFinite(v.entry) || !Number.isFinite(v.sl) || !Number.isFinite(v.tp1)) {
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

export function saveCachedLock(moduleKey: string, lock: CachedLock): void {
  try {
    localStorage.setItem(PREFIX + moduleKey, JSON.stringify(lock));
  } catch {
    /* quota / private mode */
  }
}

export function clearCachedLock(moduleKey: string): void {
  try {
    localStorage.removeItem(PREFIX + moduleKey);
  } catch {
    /* ignore */
  }
}

/** Keep OPEN locks; drop cache once server says resolved (or clear stale > 36h). */
export function syncCachedLock(
  moduleKey: string,
  latest: CachedLock | null | undefined,
): CachedLock | null {
  if (latest) {
    saveCachedLock(moduleKey, latest);
    if (latest.outcome !== "OPEN") {
      // Keep resolved briefly so UI still shows what hit, then leave it.
      return latest;
    }
    return latest;
  }
  const cached = loadCachedLock(moduleKey);
  if (!cached) return null;
  const age = Date.now() - (cached.time || 0);
  if (age > 36 * 60 * 60 * 1000) {
    clearCachedLock(moduleKey);
    return null;
  }
  // Server empty (redeploy wipe) — keep last OPEN so levels don't vanish mid-trade.
  if (cached.outcome === "OPEN") return cached;
  return cached;
}
