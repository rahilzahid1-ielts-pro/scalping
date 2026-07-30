/**
 * Probeb M5 clock — Yahoo GC=F 5m lags / gaps, so we seed once then advance
 * buckets from TradingView live quotes. Closed bars roll every wall-clock M5.
 */
import type { Candle } from "../types";
import { fetchCandles } from "../services/marketData";
import { fetchLiveQuote } from "../services/liveQuotes";
import { M5_MS, m5FloorMs } from "../strategies/probebEngine";

const MAX_BARS = 2500;

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
      // Overlay recent 1m→M5 so the last few hours are less gappy than Yahoo 5m alone.
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

/**
 * Ingest live price into the forming M5; roll closed buckets on slot change.
 */
export function ingestProbebLivePrice(price: number, now = Date.now()): void {
  if (!Number.isFinite(price) || price <= 0) return;
  const slot = m5FloorMs(now);

  if (forming && forming.time < slot) {
    pushClosed(forming);
    forming = null;
  }
  // Close any gap slots we skipped (weekend / downtime) — no synthetic OHLC;
  // just start fresh at current slot.
  while (closed.length && forming == null) {
    const lastT = closed[closed.length - 1].time;
    if (lastT + M5_MS >= slot) break;
    // Missing bars between last closed and now — leave gap; diagnose tolerates it.
    break;
  }

  if (!forming || forming.time !== slot) {
    forming = {
      time: slot,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    };
    return;
  }
  forming.high = Math.max(forming.high, price);
  forming.low = Math.min(forming.low, price);
  forming.close = price;
}

/** Closed M5 only (forming slot excluded) — Probeb identity. */
export function probebClosedM5(): Candle[] {
  const slot = m5FloorMs(Date.now());
  if (forming && forming.time < slot) {
    pushClosed(forming);
    forming = null;
  }
  return closed.filter((c) => c.time < slot).map((c) => ({ ...c }));
}

export async function refreshProbebLiveM5(): Promise<{
  primary: Candle[];
  livePrice: number;
}> {
  await ensureProbebM5Seeded();
  let livePrice = closed[closed.length - 1]?.close ?? 0;
  try {
    const q = await fetchLiveQuote("XAUUSD");
    livePrice = q.price;
    ingestProbebLivePrice(livePrice);
  } catch {
    if (forming) livePrice = forming.close;
  }
  return { primary: probebClosedM5(), livePrice };
}
