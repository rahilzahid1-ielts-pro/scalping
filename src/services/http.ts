/** Browser uses Vite proxy; Node daemon hits APIs directly */
export function resolveFetchUrl(path: string): string {
  if (typeof window !== "undefined") return path;

  if (path.startsWith("/api/yahoo")) {
    return `https://query1.finance.yahoo.com${path.replace(/^\/api\/yahoo/, "")}`;
  }
  if (path.startsWith("/api/binance-data")) {
    return `https://data-api.binance.vision${path.replace(/^\/api\/binance-data/, "")}`;
  }
  if (path.startsWith("/api/binance")) {
    return `https://api.binance.com${path.replace(/^\/api\/binance/, "")}`;
  }
  if (path.startsWith("/api/tv")) {
    return `https://scanner.tradingview.com${path.replace(/^\/api\/tv/, "")}`;
  }
  return path;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = resolveFetchUrl(path);
  const headers = new Headers(init?.headers);
  if (typeof window === "undefined") {
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", "Mozilla/5.0 SMC-AlertBot/1.0");
    }
    if (path.startsWith("/api/tv") || url.includes("tradingview")) {
      headers.set("Origin", "https://www.tradingview.com");
      headers.set("Referer", "https://www.tradingview.com/");
    }
  }
  return fetch(url, { ...init, headers });
}
