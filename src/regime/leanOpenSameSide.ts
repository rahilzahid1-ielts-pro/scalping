/**
 * Detect lean-family desks that already hold an OPEN same-side lock.
 * Used to stop Pro late-joining QS Pro / Cipher / Fractal / Quick Scalp twins
 * (2026-07-29 Pro SELL SL while lean siblings were already open).
 */
import { getLivePulseDb, getOpenOrLatestPulse } from "../pulse/store";
import {
  getLiveQuickScalpDb,
  getOpenOrLatestQuickScalp,
} from "../quickScalp/store";
import {
  getLiveStrategyDb,
  getOpenOrLatestStrategySignal,
  type CompareStrategy,
} from "../strategyCompare/store";

export type LeanOpenDesk =
  | "qs_pro"
  | "cipher_b"
  | "fractal"
  | "quick_scalp";

export type LeanOpenHit = {
  desk: LeanOpenDesk;
  direction: "BUY" | "SELL";
  entry: number;
};

function safeOpen(
  desk: LeanOpenDesk,
  direction: "BUY" | "SELL",
  read: () => { direction: string; entry: number; outcome: string } | null,
): LeanOpenHit | null {
  try {
    const row = read();
    if (!row || row.outcome !== "OPEN") return null;
    if (row.direction !== direction) return null;
    if (!Number.isFinite(row.entry)) return null;
    return { desk, direction, entry: row.entry };
  } catch {
    return null;
  }
}

/** First lean sibling (excluding Pro) with OPEN same-side lock, or null. */
export function findLeanOpenSameSide(
  direction: "BUY" | "SELL",
): LeanOpenHit | null {
  const qs = safeOpen("qs_pro", direction, () =>
    getOpenOrLatestPulse(getLivePulseDb()),
  );
  if (qs) return qs;

  const cipher = safeOpen("cipher_b", direction, () =>
    getOpenOrLatestStrategySignal(
      getLiveStrategyDb(),
      "cipher_b_clone" satisfies CompareStrategy,
    ),
  );
  if (cipher) return cipher;

  const fractal = safeOpen("fractal", direction, () =>
    getOpenOrLatestStrategySignal(
      getLiveStrategyDb(),
      "fractal" satisfies CompareStrategy,
    ),
  );
  if (fractal) return fractal;

  const quick = safeOpen("quick_scalp", direction, () =>
    getOpenOrLatestQuickScalp(getLiveQuickScalpDb()),
  );
  if (quick) return quick;

  return null;
}
