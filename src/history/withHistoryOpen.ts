/**
 * Ensure each module latest API `latest` field matches History OPEN when one exists.
 */
import { getActiveOpenLock, type ActiveOpenLock } from "./activeLock";
import type { ActiveModuleId } from "./moduleIds";

export function withHistoryOpenLatest<T extends { outcome: string }>(
  module: ActiveModuleId,
  latest: T | null,
  fromOpen: (open: ActiveOpenLock) => T,
): T | null {
  const open = getActiveOpenLock(module);
  if (open) return fromOpen(open);
  return latest;
}
