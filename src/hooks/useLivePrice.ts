import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetId, LiveQuote } from "../types";
import { ASSETS } from "../config/assets";
import { fetchLiveQuote, subscribeBinanceTicker } from "../services/liveQuotes";

const POLL_MS = 500;

/**
 * Continuous live price synced to TradingView chart symbols.
 * BTC also streams via Binance websocket for sub-second ticks.
 */
export function useLivePrice(assetId: AssetId) {
  const [quote, setQuote] = useState<LiveQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const assetIdRef = useRef(assetId);
  assetIdRef.current = assetId;

  const apply = useCallback((q: LiveQuote) => {
    if (assetIdRef.current !== assetId) return;
    setQuote(q);
    setError(null);
  }, [assetId]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let unsubWs: (() => void) | undefined;

    const poll = async () => {
      try {
        const q = await fetchLiveQuote(assetId);
        if (!cancelled) apply(q);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Quote error");
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(() => void poll(), POLL_MS);
        }
      }
    };

    void poll();

    const asset = ASSETS[assetId];
    if (asset.binanceSymbol) {
      unsubWs = subscribeBinanceTicker(asset.binanceSymbol, (q) => {
        if (!cancelled) apply(q);
      });
    }

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      unsubWs?.();
    };
  }, [assetId, apply]);

  return { quote, error, pollMs: POLL_MS };
}
