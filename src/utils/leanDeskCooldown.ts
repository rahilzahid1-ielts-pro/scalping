/**
 * In-process cooldown so QS Pro + Fractal do not both lock the same
 * spike-top chase (22 Jul: identical entry/SL, double −1R).
 */
type LeanSource = "qs_pro" | "fractal";

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

/** Skip if the other lean desk just locked same direction near this entry. */
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
