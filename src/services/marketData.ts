import type { AssetId, Candle } from "../types";
import { ASSETS } from "../config/assets";
import { fetchLiveQuote } from "./liveQuotes";
import { apiFetch } from "./http";

function mapYahooInterval(interval: string): { interval: string; range: string } {
  switch (interval) {
    case "1m":
      return { interval: "1m", range: "1d" };
    case "5m":
      return { interval: "5m", range: "5d" };
    case "15m":
      return { interval: "15m", range: "5d" };
    case "1h":
      return { interval: "60m", range: "1mo" };
    case "4h":
      return { interval: "60m", range: "3mo" };
    case "1d":
      return { interval: "1d", range: "6mo" };
    default:
      return { interval: "15m", range: "5d" };
  }
}

function mapBinanceInterval(interval: string): string {
  const map: Record<string, string> = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
  };
  return map[interval] ?? "15m";
}

async function fetchYahooCandles(symbol: string, interval: string): Promise<Candle[]> {
  const { interval: yi, range } = mapYahooInterval(interval);
  const url = `/api/yahoo/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${yi}&range=${range}`;
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("No Yahoo chart data");

  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];
  if (!quote) throw new Error("No Yahoo quote data");

  const candles: Candle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    const volume = quote.volume?.[i] ?? 0;
    if (
      open == null ||
      high == null ||
      low == null ||
      close == null ||
      Number.isNaN(open) ||
      Number.isNaN(close)
    ) {
      continue;
    }
    candles.push({
      time: timestamps[i] * 1000,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  if (interval === "4h") {
    return aggregateCandles(candles, 4);
  }
  return candles;
}

/** Aggregate lower-TF bars into N-hour candles (UTC-aligned buckets). */
export function aggregateCandles(candles: Candle[], hours: number): Candle[] {
  if (candles.length === 0) return [];
  const ms = hours * 60 * 60 * 1000;
  const grouped = new Map<number, Candle[]>();
  for (const c of candles) {
    const key = Math.floor(c.time / ms) * ms;
    const arr = grouped.get(key) ?? [];
    arr.push(c);
    grouped.set(key, arr);
  }
  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, group]) => ({
      time,
      open: group[0].open,
      high: Math.max(...group.map((g) => g.high)),
      low: Math.min(...group.map((g) => g.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, g) => s + g.volume, 0),
    }));
}

async function fetchBinanceCandles(symbol: string, interval: string): Promise<Candle[]> {
  const iv = mapBinanceInterval(interval);
  const limit = interval === "1d" ? 200 : interval === "4h" ? 200 : 300;
  const url = `/api/binance/api/v3/klines?symbol=${symbol}&interval=${iv}&limit=${limit}`;
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`Binance fetch failed: ${res.status}`);
  const raw: unknown[][] = await res.json();
  return raw.map((k) => ({
    time: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

/**
 * Scale OHLC so the last close equals live chart price.
 * Keeps structure/shape intact while aligning absolute levels with TradingView.
 */
export function rebaseCandlesToLive(candles: Candle[], livePrice: number): Candle[] {
  if (candles.length === 0 || !Number.isFinite(livePrice) || livePrice <= 0) return candles;
  const last = candles[candles.length - 1].close;
  if (!last || Math.abs(last - livePrice) / livePrice < 0.00005) {
    // Tiny gap — just patch last close for tick sync
    const copy = candles.map((c) => ({ ...c }));
    copy[copy.length - 1] = {
      ...copy[copy.length - 1],
      close: livePrice,
      high: Math.max(copy[copy.length - 1].high, livePrice),
      low: Math.min(copy[copy.length - 1].low, livePrice),
    };
    return copy;
  }
  const factor = livePrice / last;
  return candles.map((c, i) => {
    const scaled = {
      ...c,
      open: c.open * factor,
      high: c.high * factor,
      low: c.low * factor,
      close: c.close * factor,
    };
    if (i === candles.length - 1) {
      scaled.close = livePrice;
      scaled.high = Math.max(scaled.high, livePrice);
      scaled.low = Math.min(scaled.low, livePrice);
    }
    return scaled;
  });
}

export async function fetchCandles(assetId: AssetId, interval: string): Promise<Candle[]> {
  const asset = ASSETS[assetId];
  if (asset.binanceSymbol) {
    return fetchBinanceCandles(asset.binanceSymbol, interval);
  }
  if (asset.yahooSymbol) {
    return fetchYahooCandles(asset.yahooSymbol, interval);
  }
  throw new Error(`No data source for ${assetId}`);
}

export async function fetchMultiTimeframe(
  assetId: AssetId,
  mode: "scalping" | "intraday",
  livePrice?: number,
) {
  let frames;
  if (mode === "scalping") {
    const [m5, m15, h1, daily] = await Promise.all([
      fetchCandles(assetId, "5m"),
      fetchCandles(assetId, "15m"),
      fetchCandles(assetId, "1h"),
      fetchCandles(assetId, "1d"),
    ]);
    frames = { primary: m5, confirmation: m15, bias: h1, daily };
  } else {
    const [m15, h1, h4, daily] = await Promise.all([
      fetchCandles(assetId, "15m"),
      fetchCandles(assetId, "1h"),
      fetchCandles(assetId, "4h"),
      fetchCandles(assetId, "1d"),
    ]);
    frames = { primary: m15, confirmation: h1, bias: h4, daily };
  }

  let price = livePrice;
  if (price == null) {
    try {
      price = (await fetchLiveQuote(assetId)).price;
    } catch {
      price = frames.primary.at(-1)?.close;
    }
  }

  if (price != null) {
    return {
      primary: rebaseCandlesToLive(frames.primary, price),
      confirmation: rebaseCandlesToLive(frames.confirmation, price),
      bias: rebaseCandlesToLive(frames.bias, price),
      daily: rebaseCandlesToLive(frames.daily, price),
      livePrice: price,
    };
  }

  return { ...frames, livePrice: frames.primary.at(-1)?.close ?? 0 };
}

/** Shift trade levels when live price ticks between signal refreshes */
export function shiftLevelsByDelta<T extends { entry: number; stopLoss: number; takeProfit1: number; takeProfit2: number; takeProfit3: number; invalidation: number; riskReward: number } | null>(
  levels: T,
  fromPrice: number,
  toPrice: number,
): T {
  if (!levels || !Number.isFinite(fromPrice) || !Number.isFinite(toPrice)) return levels;
  const d = toPrice - fromPrice;
  if (Math.abs(d) < 1e-12) return levels;
  return {
    ...levels,
    entry: levels.entry + d,
    stopLoss: levels.stopLoss + d,
    takeProfit1: levels.takeProfit1 + d,
    takeProfit2: levels.takeProfit2 + d,
    takeProfit3: levels.takeProfit3 + d,
    invalidation: levels.invalidation + d,
  };
}
