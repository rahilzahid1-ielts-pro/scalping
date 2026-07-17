export type AssetId = "XAUUSD" | "XAGUSD" | "BTCUSD";
export type TradeMode = "scalping" | "intraday";
export type Side = "BUY" | "SELL" | "WAIT";
export type Bias = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AssetConfig {
  id: AssetId;
  name: string;
  symbol: string;
  tvSymbol: string;
  /** TradingView scanner ticker (must match chart for live sync) */
  quoteTicker: string;
  quoteMarket: "cfd" | "crypto" | "forex";
  yahooSymbol?: string;
  binanceSymbol?: string;
  pipSize: number;
  decimals: number;
  description: string;
}

export interface LiveQuote {
  price: number;
  bid?: number;
  ask?: number;
  spread?: number;
  high?: number;
  low?: number;
  source: string;
  ts: number;
}

export interface MaSignal {
  trend: Bias;
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  alignment: number;
  crossover: "bullish" | "bearish" | "none";
  score: number;
  notes: string[];
}

export interface SmcSignal {
  structure: Bias;
  bos: "bullish" | "bearish" | "none";
  choch: "bullish" | "bearish" | "none";
  orderBlock?: { type: "bullish" | "bearish"; high: number; low: number };
  fvg?: { type: "bullish" | "bearish"; high: number; low: number };
  liquiditySweep?: "buy_side" | "sell_side" | "none";
  premiumDiscount: "premium" | "discount" | "equilibrium";
  score: number;
  notes: string[];
}

export interface PriceActionSignal {
  pattern: string;
  bias: Bias;
  score: number;
  notes: string[];
}

export interface TradeLevels {
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  riskReward: number;
  invalidation: number;
}

export interface BiasForecast {
  bias: Bias;
  confidence: number;
  startZone: number;
  keyLevel: number;
  rationale: string[];
}

/** Locked path forecast: price may go from X → Y (stable, not tick-based) */
export interface RangePrediction {
  direction: Bias;
  from: number;
  to: number;
  confidence: number;
  winProbability: number;
  invalidation: number;
  magnetLevel: number;
  atrReach: number;
  rsi: number;
  pivots: { pp: number; r1: number; s1: number; r2: number; s2: number };
  reasons: string[];
  horizon: string;
  summary: string;
}

export type RegimeTag = "TREND_UP" | "TREND_DOWN" | "RANGE";

export interface SignalDiagnostics {
  bullPts: number;
  bearPts: number;
  confluencePct: number;
  smcScore: number;
  maScore: number;
  paScore: number;
  htfAligned: boolean;
  conflictingSignals: boolean;
  /** True when confidence + winChance were capped at 65% due to conflict */
  conflictCapped: boolean;
  atr14: number;
  atrPctOfPrice: number;
  regime: RegimeTag;
}

export interface LiveSignal {
  asset: AssetId;
  mode: TradeMode;
  side: Side;
  confidence: number;
  price: number;
  timestamp: number;
  ma: MaSignal;
  smc: SmcSignal;
  priceAction: PriceActionSignal;
  levels: TradeLevels | null;
  dailyBias: BiasForecast;
  tomorrowBias: BiasForecast;
  rangePrediction: RangePrediction;
  confluence: string[];
  actionPlan: string;
  timeframeHint: string;
  diagnostics: SignalDiagnostics;
}
