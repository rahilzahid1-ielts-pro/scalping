import type { AssetId, LiveQuote } from "../types";
import { ASSETS } from "../config/assets";
import { apiFetch } from "./http";

interface TvScanRow {
  s: string;
  d: (number | string | null)[];
}

interface TvScanResponse {
  data?: TvScanRow[];
}

/**
 * For metals: ALWAYS prefer last close (tracks chart better than lagged bid/ask mid).
 * Also expose ask/bid for entry-probe (SELL uses ask/high side).
 */
function pickMetalPrice(close?: number, bid?: number, ask?: number): number {
  if (close != null && Number.isFinite(close) && close > 0) return close;
  if (bid != null && ask != null && bid > 0 && ask > 0) return (bid + ask) / 2;
  return ask ?? bid ?? 0;
}

export async function fetchTradingViewQuote(assetId: AssetId): Promise<LiveQuote> {
  const asset = ASSETS[assetId];
  const body = {
    symbols: {
      tickers: [asset.quoteTicker],
      query: { types: [] as string[] },
    },
    // close first — lp often null on CFD scan
    columns: ["close", "bid", "ask", "high", "low", "open", "change", "description", "update_mode"],
  };

  const res = await apiFetch(`/api/tv/${asset.quoteMarket}/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`TV quote failed: ${res.status}`);
  const json = (await res.json()) as TvScanResponse;
  const row = json.data?.[0];
  if (!row?.d?.length) throw new Error(`No TV quote for ${asset.quoteTicker}`);

  const close = Number(row.d[0]);
  const bid = row.d[1] != null ? Number(row.d[1]) : undefined;
  const ask = row.d[2] != null ? Number(row.d[2]) : undefined;

  const isMetal = assetId === "XAUUSD" || assetId === "XAGUSD";
  const price = isMetal
    ? pickMetalPrice(close, bid, ask)
    : bid != null && ask != null && bid > 0 && ask > 0
      ? (bid + ask) / 2
      : close;

  if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid TV price");

  // Near-price probe ONLY (never day high/low — that falsely triggers TOO_LATE)
  const near = [close, bid, ask].filter(
    (n): n is number => n != null && Number.isFinite(n) && n > 0,
  );
  const probeHigh = near.length ? Math.max(...near) : price;
  const probeLow = near.length ? Math.min(...near) : price;

  return {
    price,
    bid: Number.isFinite(bid) ? bid : undefined,
    ask: Number.isFinite(ask) ? ask : undefined,
    spread:
      bid != null && ask != null && Number.isFinite(bid) && Number.isFinite(ask)
        ? ask - bid
        : undefined,
    high: probeHigh,
    low: probeLow,
    source: `TV close · ${asset.quoteTicker}`,
    ts: Date.now(),
  };
}

async function fetchBinanceSpotFrom(
  basePath: "/api/binance" | "/api/binance-data",
  symbol: string,
): Promise<LiveQuote> {
  const res = await apiFetch(`${basePath}/api/v3/ticker/bookTicker?symbol=${symbol}`);
  if (!res.ok) {
    const res2 = await apiFetch(`${basePath}/api/v3/ticker/price?symbol=${symbol}`);
    if (!res2.ok) throw new Error(`Binance ticker failed: ${res2.status}`);
    const data = (await res2.json()) as { price: string };
    const price = Number(data.price);
    return { price, high: price, low: price, source: `Binance ${symbol}`, ts: Date.now() };
  }
  const data = (await res.json()) as { bidPrice: string; askPrice: string };
  const bid = Number(data.bidPrice);
  const ask = Number(data.askPrice);
  const price = (bid + ask) / 2;
  return {
    price,
    bid,
    ask,
    spread: ask - bid,
    high: ask,
    low: bid,
    source: `Binance book · ${symbol}`,
    ts: Date.now(),
  };
}

export async function fetchBinanceSpotPrice(symbol: string): Promise<LiveQuote> {
  try {
    return await fetchBinanceSpotFrom("/api/binance", symbol);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/451|403|failed/i.test(msg)) throw e;
    return fetchBinanceSpotFrom("/api/binance-data", symbol);
  }
}

async function fetchYahooSpotPrice(yahooSymbol: string): Promise<LiveQuote> {
  const res = await apiFetch(
    `/api/yahoo/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1m&range=1d`,
  );
  if (!res.ok) throw new Error(`Yahoo ticker failed: ${res.status}`);
  const json = await res.json();
  const price = Number(json?.chart?.result?.[0]?.meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error("Invalid Yahoo price");
  return {
    price,
    high: price,
    low: price,
    source: `Yahoo ${yahooSymbol}`,
    ts: Date.now(),
  };
}

export async function fetchLiveQuote(assetId: AssetId): Promise<LiveQuote> {
  const asset = ASSETS[assetId];
  const errors: string[] = [];

  try {
    return await fetchTradingViewQuote(assetId);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  if (asset.binanceSymbol) {
    try {
      return await fetchBinanceSpotPrice(asset.binanceSymbol);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (asset.yahooSymbol) {
    try {
      return await fetchYahooSpotPrice(asset.yahooSymbol);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  throw new Error(`No quote source for ${assetId}: ${errors.join(" | ")}`);
}

export function subscribeBinanceTicker(
  symbol: string,
  onPrice: (quote: LiveQuote) => void,
): () => void {
  const ws = new WebSocket(
    `wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@bookTicker`,
  );
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { b?: string; a?: string };
      const bid = Number(msg.b);
      const ask = Number(msg.a);
      if (Number.isFinite(bid) && Number.isFinite(ask)) {
        onPrice({
          price: (bid + ask) / 2,
          bid,
          ask,
          spread: ask - bid,
          high: ask,
          low: bid,
          source: `Binance WS ${symbol}`,
          ts: Date.now(),
        });
      }
    } catch {
      /* ignore */
    }
  };
  return () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
}
