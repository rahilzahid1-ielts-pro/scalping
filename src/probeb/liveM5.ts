/**
 * Probeb M5 clock — Yahoo GC=F 5m lags / gaps, so we seed once then advance
 * buckets from TradingView live quotes. Closed bars roll every wall-clock M5.
 *
 * Critical: wall-clock slot roll must NEVER depend on accepting a live quote.
 * Spike rejects used to early-return before roll → predictions lagged 1–2 slots.
 */
import type { Candle } from "../types";
import { fetchCandles } from "../services/marketData";
import { fetchLiveQuote } from "../services/liveQuotes";
import { m5FloorMs, M5_MS } from "../strategies/probebEngine";

const MAX_BARS = 2500;
const SPIKE_USD = 25;

type Bucket = Candle;

let seeded = false;
let seedPromise: Promise<void> | null = null;
/** Fully closed M5 buckets (never includes the forming slot). */
const closed: Bucket[] = [];
/** Forming M5 slot (wall-clock). */
let forming: Bucket | null = null;

function pushClosed(b: Bucket): void {
  const last = closed[closed.length - 1];
  if (last && last.time === b.time) {
    closed[closed.length - 1] = b;
    return;
  }
  if (last && last.time > b.time) return;
  closed.push(b);
  if (closed.length > MAX_BARS) closed.splice(0, closed.length - MAX_BARS);
}

function lastGoodPx(): number {
  return forming?.close ?? closed[closed.length - 1]?.close ?? 0;
}

/** Median of recent closed closes — resists a single spiked bar freezing the clock. */
function recentCloseMedian(n = 8): number | null {
  if (closed.length === 0) return null;
  const sample = closed.slice(-n).map((c) => c.close).sort((a, b) => a - b);
  return sample[Math.floor(sample.length / 2)] ?? null;
}

/**
 * Advance closed/forming buckets to wall-clock `now` even with no quote.
 * Fills skipped M5 slots so diagnose never sits on a stale last closed bar.
 */
export function advanceProbebClock(now = Date.now()): void {
  const slot = m5FloorMs(now);

  if (forming && forming.time < slot) {
    pushClosed(forming);
    forming = null;
  }

  const fillPx = lastGoodPx();
  let lastT = closed[closed.length - 1]?.time;
  if (lastT != null && fillPx > 0) {
    // Cap catch-up so a huge gap doesn't invent hours of flat bars.
    const maxFill = slot - 12 * M5_MS;
    let t = lastT + M5_MS;
    if (t < maxFill) t = maxFill;
    for (; t < slot; t += M5_MS) {
      if (closed.some((c) => c.time === t)) continue;
      pushClosed({
        time: t,
        open: fillPx,
        high: fillPx,
        low: fillPx,
        close: fillPx,
        volume: 0,
      });
    }
  }

  if (!forming || forming.time !== slot) {
    const px = fillPx > 0 ? fillPx : 0;
    if (px > 0) {
      forming = {
        time: slot,
        open: px,
        high: px,
        low: px,
        close: px,
        volume: 0,
      };
    }
  }
}

function seedFromYahoo(raw: Candle[]): void {
  const bySlot = new Map<number, Bucket>();
  for (const c of raw) {
    const flo = m5FloorMs(c.time);
    bySlot.set(flo, {
      time: flo,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
    });
  }
  const nowSlot = m5FloorMs(Date.now());
  const sorted = [...bySlot.entries()].sort((a, b) => a[0] - b[0]);
  for (const [t, b] of sorted) {
    if (t > nowSlot) continue;
    if (t === nowSlot) {
      forming = { ...b };
      continue;
    }
    pushClosed(b);
  }
  advanceProbebClock(Date.now());
}

export async function ensureProbebM5Seeded(): Promise<void> {
  if (seeded) return;
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    try {
      let raw: Candle[] = [];
      try {
        raw = await fetchCandles("XAUUSD", "5m");
      } catch {
        raw = [];
      }
      try {
        const m1 = aggregateM1ToM5(await fetchCandles("XAUUSD", "1m"));
        const map = new Map<number, Candle>();
        for (const c of raw) map.set(m5FloorMs(c.time), { ...c, time: m5FloorMs(c.time) });
        for (const c of m1) map.set(c.time, c);
        raw = [...map.values()].sort((a, b) => a.time - b.time);
      } catch {
        /* 5m seed is enough */
      }
      if (raw.length < 50) {
        throw new Error("Probeb M5 seed too short");
      }
      seedFromYahoo(raw);
      seeded = true;
    } finally {
      seedPromise = null;
    }
  })();
  return seedPromise;
}

export function aggregateM1ToM5(m1: Candle[]): Candle[] {
  const bySlot = new Map<number, Candle[]>();
  for (const c of m1) {
    const flo = m5FloorMs(c.time);
    const arr = bySlot.get(flo) ?? [];
    arr.push(c);
    bySlot.set(flo, arr);
  }
  return [...bySlot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, group]) => ({
      time,
      open: group[0].open,
      high: Math.max(...group.map((g) => g.high)),
      low: Math.min(...group.map((g) => g.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, g) => s + (g.volume ?? 0), 0),
    }));
}

/** Collapse spiked OHLC onto a sane anchor (live or peer median). */
export function scrubSpikedClosedBars(livePrice: number): void {
  if (!(Number.isFinite(livePrice) && livePrice > 0)) return;
  const mid = recentCloseMedian(12);
  // Prefer live when it's near the peer mid; otherwise mid; else live.
  let anchor = livePrice;
  if (mid != null) {
    if (Math.abs(livePrice - mid) <= SPIKE_USD) anchor = livePrice;
    else anchor = mid;
  }

  const scrubOne = (b: Bucket): Bucket => {
    const farClose = Math.abs(b.close - anchor) > SPIKE_USD;
    const farHigh = Math.abs(b.high - anchor) > SPIKE_USD * 1.5;
    const farLow = Math.abs(b.low - anchor) > SPIKE_USD * 1.5;
    if (!farClose && !farHigh && !farLow) return b;
    // Fake green/red impulse from a TV spike — flatten to anchor so diagnose
    // cannot print STRONG BUY/SELL against the real tape.
    return {
      ...b,
      open: anchor,
      high: anchor,
      low: anchor,
      close: anchor,
    };
  };

  for (let i = Math.max(0, closed.length - 8); i < closed.length; i++) {
    closed[i] = scrubOne(closed[i]!);
  }
  if (forming) forming = scrubOne(forming);
}

/**
 * Ingest live price into the forming M5. Slot roll happens first (always).
 * Spike quotes are ignored for OHLC, but the clock still advances.
 */
export function ingestProbebLivePrice(price: number, now = Date.now()): void {
  if (!Number.isFinite(price) || price <= 0) return;
  advanceProbebClock(now);
  scrubSpikedClosedBars(price);

  const ref = forming?.close ?? closed[closed.length - 1]?.close;
  const mid = recentCloseMedian(8);
  const vsRef = ref != null ? Math.abs(price - ref) : 0;
  const vsMid = mid != null ? Math.abs(price - mid) : 0;

  // Last bar spiked (e.g. 4160) while live + peer mid are sane (~4100) → trust live.
  const lastIsOutlier =
    ref != null && mid != null && Math.abs(ref - mid) > SPIKE_USD && vsMid <= SPIKE_USD;

  if (ref && vsRef > SPIKE_USD && !lastIsOutlier) {
    return;
  }

  if (!forming) {
    forming = {
      time: m5FloorMs(now),
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    };
    return;
  }

  if (lastIsOutlier) {
    forming.open = price;
    forming.high = price;
    forming.low = price;
    forming.close = price;
    // Also flatten the last closed spike so diagnose cannot STRONG off it.
    scrubSpikedClosedBars(price);
    return;
  }

  forming.high = Math.max(forming.high, price);
  forming.low = Math.min(forming.low, price);
  forming.close = price;
}

/** Overwrite recent closed slots with Yahoo/1m OHLC so body color matches the chart. */
async function resyncRecentClosedFromFeed(): Promise<void> {
  try {
    let raw: Candle[] = [];
    try {
      raw = await fetchCandles("XAUUSD", "5m");
    } catch {
      raw = [];
    }
    try {
      const m1 = aggregateM1ToM5(await fetchCandles("XAUUSD", "1m"));
      const map = new Map<number, Candle>();
      for (const c of raw) map.set(m5FloorMs(c.time), { ...c, time: m5FloorMs(c.time) });
      for (const c of m1) map.set(c.time, c);
      raw = [...map.values()].sort((a, b) => a.time - b.time);
    } catch {
      /* keep 5m */
    }
    if (raw.length < 10) return;
    const nowSlot = m5FloorMs(Date.now());
    const cutoff = nowSlot - 12 * 60 * 60 * 1000;
    for (const c of raw) {
      const flo = m5FloorMs(c.time);
      if (flo < cutoff || flo >= nowSlot) continue;
      const bar: Bucket = {
        time: flo,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume ?? 0,
      };
      const idx = closed.findIndex((x) => x.time === flo);
      if (idx >= 0) closed[idx] = bar;
      else pushClosed(bar);
    }
    closed.sort((a, b) => a.time - b.time);
    advanceProbebClock(Date.now());
  } catch {
    /* keep in-memory clock */
  }
}

/** Closed M5 only (forming slot excluded) — Probeb identity. */
export function probebClosedM5(): Candle[] {
  advanceProbebClock(Date.now());
  const slot = m5FloorMs(Date.now());
  return closed.filter((c) => c.time < slot).map((c) => ({ ...c }));
}

let lastResyncAt = 0;

export async function refreshProbebLiveM5(): Promise<{
  primary: Candle[];
  livePrice: number;
}> {
  await ensureProbebM5Seeded();
  advanceProbebClock(Date.now());

  // Re-pull Yahoo/1m often so SAHI/GALAT + clock stay on real OHLC.
  if (Date.now() - lastResyncAt > 20_000) {
    await resyncRecentClosedFromFeed();
    lastResyncAt = Date.now();
  }

  let livePrice = lastGoodPx();
  try {
    const q = await fetchLiveQuote("XAUUSD");
    livePrice = q.price;
    ingestProbebLivePrice(livePrice);
  } catch {
    /* keep last good */
  }
  scrubSpikedClosedBars(livePrice);
  return { primary: probebClosedM5(), livePrice };
}
