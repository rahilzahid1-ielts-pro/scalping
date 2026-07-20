/**
 * When a confirmed module lock disappears without TP1/SL,
 * warn the user they may need to EXIT a trade they already took.
 * Does not change engines — display / paint-cache only.
 */
import { clearCachedLock } from "./lockCache";
import { historyModuleToActiveId, type ActiveModuleId } from "../history/activeLock";

const PREFIX = "go_exit_advisory_v1:";

export interface ExitAdvisory {
  moduleKey: string;
  moduleLabel: string;
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  givenAt: number;
  reason: string;
  kind: "lock_revoked" | "preview_cancelled";
}

export interface ConfirmedLockSnap {
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  outcome: string;
  time: number;
}

function loadRaw(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function saveRaw(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    /* ignore */
  }
}

function clearRaw(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

export function loadExitAdvisory(moduleKey: string): ExitAdvisory | null {
  const raw = loadRaw(`adv:${moduleKey}`);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as ExitAdvisory;
    if (!v?.side || !Number.isFinite(v.entry)) return null;
    if (Date.now() - (v.givenAt || 0) > 12 * 60 * 60 * 1000) {
      clearRaw(`adv:${moduleKey}`);
      return null;
    }
    return v;
  } catch {
    return null;
  }
}

export function dismissExitAdvisory(moduleKey: string): void {
  clearRaw(`adv:${moduleKey}`);
}

/**
 * Pass **server** latest only (not phone cache).
 * If History still has OPEN for this module, never emit EXIT / clear cache.
 */
export function syncExitAdvisory(
  moduleKey: string,
  moduleLabel: string,
  serverLock: ConfirmedLockSnap | null,
  waitReason?: string | null,
  /** When true, History DB still has OPEN — do not revoke UI */
  historyStillOpen?: boolean,
): ExitAdvisory | null {
  const snapKey = `snap:${moduleKey}`;

  if (historyStillOpen || (serverLock && serverLock.outcome === "OPEN")) {
    if (serverLock && serverLock.outcome === "OPEN") {
      saveRaw(snapKey, JSON.stringify(serverLock));
    }
    clearRaw(`adv:${moduleKey}`);
    return null;
  }

  if (serverLock && (serverLock.outcome === "TP1_HIT" || serverLock.outcome === "SL_HIT")) {
    clearRaw(snapKey);
    clearRaw(`adv:${moduleKey}`);
    return null;
  }

  if (serverLock && serverLock.outcome === "INVALIDATED") {
    const adv: ExitAdvisory = {
      moduleKey,
      moduleLabel,
      side: serverLock.side,
      entry: serverLock.entry,
      sl: serverLock.sl,
      tp1: serverLock.tp1,
      givenAt: serverLock.time,
      kind: "lock_revoked",
      reason: waitReason || "Lock invalidate — pehle wala setup ab valid nahi",
    };
    saveRaw(`adv:${moduleKey}`, JSON.stringify(adv));
    clearRaw(snapKey);
    clearCachedLock(moduleKey);
    return adv;
  }

  const prevRaw = loadRaw(snapKey);
  if (!serverLock && prevRaw) {
    try {
      const prev = JSON.parse(prevRaw) as ConfirmedLockSnap;
      if (prev.outcome === "OPEN") {
        const adv: ExitAdvisory = {
          moduleKey,
          moduleLabel,
          side: prev.side,
          entry: prev.entry,
          sl: prev.sl,
          tp1: prev.tp1,
          givenAt: prev.time,
          kind: "lock_revoked",
          reason:
            waitReason ||
            "Pehle trade di thi, ab setup/gate match nahi — decision hold nahi raha",
        };
        saveRaw(`adv:${moduleKey}`, JSON.stringify(adv));
        clearRaw(snapKey);
        clearCachedLock(moduleKey);
        return adv;
      }
    } catch {
      clearRaw(snapKey);
    }
  }

  return loadExitAdvisory(moduleKey);
}

export function formatExitAdvisoryUr(a: ExitAdvisory): string {
  if (a.kind === "preview_cancelled") {
    return `${a.moduleLabel} pe ${a.side} preview tha @ ${a.entry.toFixed(2)}, lekin worker ne lock nahi kiya. Naya entry mat lo.`;
  }
  return `${a.moduleLabel} ne ${a.side} trade di thi @ ${a.entry.toFixed(2)} (SL ${a.sl.toFixed(2)} · TP1 ${a.tp1.toFixed(2)}). Ab woh situation nahi — agar aapne trade le li hai to EXIT consider karo / SL respect karo.`;
}

export function cacheKeyToActiveModule(cacheKey: string): ActiveModuleId | null {
  return historyModuleToActiveId(cacheKey);
}
