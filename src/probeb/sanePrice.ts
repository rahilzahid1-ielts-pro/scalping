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

/**
 * When live and peer-mid disagree by >maxDev, pick the one nearer to an
 * external feed close. Never trust a contaminated mid over a fresh live that
 * matches the feed (was: mid stuck at 4104 while live was 4035).
 */
export function pickTapeAnchor(
  live: number,
  mid: number | null | undefined,
  feed: number | null | undefined,
  maxDevUsd = 20,
): number {
  if (!(Number.isFinite(live) && live > 0)) {
    if (mid != null && Number.isFinite(mid) && mid > 0) return mid;
    return live;
  }
  if (mid == null || !Number.isFinite(mid) || mid <= 0) return live;
  if (Math.abs(live - mid) <= maxDevUsd) return live;

  if (feed != null && Number.isFinite(feed) && feed > 0) {
    const dLive = Math.abs(live - feed);
    const dMid = Math.abs(mid - feed);
    if (dLive <= maxDevUsd) return live;
    if (dMid <= maxDevUsd) return mid;
    return dLive <= dMid ? live : mid;
  }
  // No feed — peer mid is multi-bar consensus; a lone TV tick is more often the spike.
  return mid;
}
