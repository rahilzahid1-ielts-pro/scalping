/** True when the bar traded through the entry level (actual start / apply). */
export function barTouchedEntryLevel(
  entry: number,
  bar: { high: number; low: number },
): boolean {
  if (!Number.isFinite(entry) || !Number.isFinite(bar.high) || !Number.isFinite(bar.low)) {
    return false;
  }
  return bar.low <= entry && bar.high >= entry;
}
