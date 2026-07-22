/**
 * Phone/local paint cache for module locks.
 * Survives Railway redeploys that wipe empty (no-volume) SQLite.
 * Not authority — server `latest` always wins when present.
 *
 * v2: resolved TP/SL must not ghost for 48h after server clears `latest`
 * (that stuck QS Pro on "BUY · TP2 HIT · phone cache").
 */
const PREFIX = "go_lock_cache_v2:";
/** Drop any leftover v1 ghosts once. */
const LEGACY_PREFIX = "go_lock_cache_v1:";

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

function purgeLegacy(moduleKey: string): void {
  try {
    localStorage.removeItem(LEGACY_PREFIX + moduleKey);
  } catch {
    /* ignore */
  }
}

export function loadCachedLock(moduleKey: string): CachedLock | null {
  purgeLegacy(moduleKey);
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
  purgeLegacy(moduleKey);
  try {
    localStorage.setItem(PREFIX + moduleKey, JSON.stringify(lock));
  } catch {
    /* quota / private mode */
  }
}

export function clearCachedLock(moduleKey: string): void {
  purgeLegacy(moduleKey);
  try {
    localStorage.removeItem(PREFIX + moduleKey);
  } catch {
    /* ignore */
  }
}

/**
 * Server row wins when present.
 * If server empty:
 *   - keep OPEN briefly (redeploy wipe survival, max 7d)
 *   - never keep resolved TP/SL — those ghost locks freeze the desk
 */
export function syncCachedLock(
  moduleKey: string,
  latest: CachedLock | null | undefined,
): CachedLock | null {
  if (latest) {
    saveCachedLock(moduleKey, latest);
    return latest;
  }
  const cached = loadCachedLock(moduleKey);
  if (!cached) return null;

  if (cached.outcome === "OPEN") {
    const age = Date.now() - (cached.time || 0);
    if (age > 7 * 24 * 60 * 60 * 1000) {
      clearCachedLock(moduleKey);
      return null;
    }
    return cached;
  }

  // TP1/TP2/SL/INVALIDATED: server said null → desk is free.
  clearCachedLock(moduleKey);
  return null;
}
