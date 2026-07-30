/**
 * Robust gold mid — drops TV spike outliers so 4144/4177 don't pull the anchor.
 */
export function robustPriceMid(
  prices: number[],
  maxDevUsd = 30,
): number | null {
  const clean = prices.filter((p) => Number.isFinite(p) && p > 0);
  if (!clean.length) return null;
  let sample = [...clean].sort((a, b) => a - b);
  for (let i = 0; i < 5; i++) {
    const mid = sample[Math.floor(sample.length / 2)]!;
    const next = sample.filter((x) => Math.abs(x - mid) <= maxDevUsd);
    if (next.length < 3) return mid;
    if (next.length === sample.length) return mid;
    sample = next.sort((a, b) => a - b);
  }
  return sample[Math.floor(sample.length / 2)]!;
}

/** True when `price` is a clear spike vs the robust tape mid. */
export function isSpikeVsAnchor(
  price: number,
  anchor: number | null | undefined,
  maxUsd = 20,
): boolean {
  if (!(Number.isFinite(price) && price > 0)) return true;
  if (anchor == null || !Number.isFinite(anchor) || anchor <= 0) return false;
  return Math.abs(price - anchor) > maxUsd;
}
