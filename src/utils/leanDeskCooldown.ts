/**
 * In-process cooldown so lean-family desks do not stack the same
 * spike / bounce print (QS Pro + Fractal + Cipher + Quick Scalp).
 */
export type LeanSource = "qs_pro" | "fractal" | "cipher_b" | "quick_scalp";

type LeanStamp = {
  source: LeanSource;
  direction: "BUY" | "SELL";
  entry: number;
  at: number;
};

let lastLean: LeanStamp | null = null;

const WINDOW_MS = 90 * 60 * 1000;
const ENTRY_TOL = 8; // $8 on XAUUSD — same spike zone

export function noteLeanDeskLock(
  source: LeanSource,
  direction: "BUY" | "SELL",
  entry: number,
): void {
  lastLean = { source, direction, entry, at: Date.now() };
}

/** Skip if another lean desk just locked same direction near this entry. */
export function shouldSkipCorrelatedLeanLock(
  source: LeanSource,
  direction: "BUY" | "SELL",
  entry: number,
  now = Date.now(),
): boolean {
  if (!lastLean) return false;
  if (lastLean.source === source) return false;
  if (now - lastLean.at > WINDOW_MS) return false;
  if (lastLean.direction !== direction) return false;
  if (Math.abs(lastLean.entry - entry) > ENTRY_TOL) return false;
  return true;
}
