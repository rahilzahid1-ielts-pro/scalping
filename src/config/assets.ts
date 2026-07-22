import type { AssetConfig, AssetId } from "../types";

export const ASSETS: Record<AssetId, AssetConfig> = {
  XAUUSD: {
    id: "XAUUSD",
    name: "Gold",
    symbol: "XAU/USD",
    // Chart embed: TVC:GOLD is reliable on free Advanced Chart widget.
    // Live mid stays on OANDA via quoteTicker (scanner).
    tvSymbol: "TVC:GOLD",
    quoteTicker: "OANDA:XAUUSD",
    quoteMarket: "cfd",
    yahooSymbol: "GC=F",
    pipSize: 0.1,
    decimals: 2,
    description: "Gold vs US Dollar",
  },
  XAGUSD: {
    id: "XAGUSD",
    name: "Silver",
    symbol: "XAG/USD",
    // TVC:SILVER matches live scanner quotes (OANDA XAGUSD spot is not exposed on scanner)
    tvSymbol: "TVC:SILVER",
    quoteTicker: "TVC:SILVER",
    quoteMarket: "cfd",
    yahooSymbol: "SI=F",
    pipSize: 0.01,
    decimals: 3,
    description: "Silver vs US Dollar",
  },
  BTCUSD: {
    id: "BTCUSD",
    name: "Bitcoin",
    symbol: "BTC/USD",
    tvSymbol: "BINANCE:BTCUSDT",
    quoteTicker: "BINANCE:BTCUSDT",
    quoteMarket: "crypto",
    binanceSymbol: "BTCUSDT",
    // Yahoo fallback when Binance returns 451 (geo-block on Railway / some regions)
    yahooSymbol: "BTC-USD",
    pipSize: 1,
    decimals: 2,
    description: "Bitcoin vs US Dollar",
  },
};

/** UI picker — Gold only (Silver/Bitcoin hidden from the desk). */
export const ASSET_LIST = [ASSETS.XAUUSD];
