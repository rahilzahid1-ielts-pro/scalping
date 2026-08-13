/** Browser uses Vite proxy; Node daemon hits APIs directly. */
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

function yahooDirectUrls(path: string): string[] {
  const rest = path.replace(/^\/api\/yahoo/, "");
  return [
    `https://query1.finance.yahoo.com${rest}`,
    `https://query2.finance.yahoo.com${rest}`,
  ];
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (typeof window === "undefined") {
    if (!headers.has("User-Agent")) {
      // Browser-like UA — "SMC-AlertBot" was getting Yahoo 429'd harder on Railway.
      headers.set(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      );
    }
    if (path.startsWith("/api/tv") || path.includes("tradingview")) {
      headers.set("Origin", "https://www.tradingview.com");
      headers.set("Referer", "https://www.tradingview.com/");
    }
  }

  // Node Yahoo: query1 → brief backoff → query2 on rate-limit.
  if (typeof window === "undefined" && path.startsWith("/api/yahoo")) {
    let last: Response | null = null;
    for (const url of yahooDirectUrls(path)) {
      last = await fetch(url, { ...init, headers });
      if (last.ok) return last;
      if (last.status !== 429 && last.status !== 503) return last;
      await new Promise((r) => setTimeout(r, 500));
    }
    return last!;
  }

  return fetch(resolveFetchUrl(path), { ...init, headers });
}
