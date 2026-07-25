/**
 * Learn layer types — train from past EXECUTED trades, gate live locks.
 */
export type LearnModule =
  | "scalp"
  | "intraday"
  | "quick_scalp"
  | "qs_pro"
  | "pro"
  | "intra30"
  | "cipher_b"
  | "fractal"
  | "unknown";

export type LearnLabel = 0 | 1; // 0 = win (TP), 1 = SL

export type LearnSession = "asia_am" | "mid" | "eve" | "night";
export type LearnTrend = "up" | "down" | "flat";
export type LearnVol = "low" | "mid" | "high";

export interface LearnRow {
  id: string;
  module: LearnModule;
  moduleLabel: string;
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  slMoney: number;
  tp1Money: number;
  executedAt: number;
  resolvedAt: number | null;
  outcome: "TP1_HIT" | "TP2_HIT" | "SL_HIT";
  realizedR: number | null;
  pnlMoney: number | null;
  source: string;
  /** PKT session at fill — set by marketContext enrich. */
  session?: LearnSession;
  /** M5 trend vs SMA50 at fill. */
  trend?: LearnTrend;
  /** ATR(14) percentile bucket vs ~5d window. */
  vol?: LearnVol;
}

export interface LearnFeatures {
  /** Ordered feature names matching vector indices. */
  names: string[];
  vector: number[];
}

export type ModuleMarketVerdict = "strong" | "ok" | "weak" | "avoid";

export interface ModuleMarketCell {
  key: string;
  module: string;
  session?: string;
  trend?: string;
  vol?: string;
  side?: string;
  n: number;
  w: number;
  l: number;
  wr: number;
  verdict: ModuleMarketVerdict;
}

export interface ScenarioBucket {
  key: string;
  n: number;
  sl: number;
  wr: number;
  rate: number;
  action: "prefer" | "allow" | "throttle" | "avoid";
  tip: string;
}

export interface TpWinStat {
  id: string;
  label: string;
  n: number;
  pctOfWins: number;
  examples: string[];
  tip: string;
}

export interface TrainedModel {
  version: 1;
  trainedAt: string;
  sampleN: number;
  winN: number;
  lossN: number;
  featureNames: string[];
  /** Logistic weights: bias + one per feature. */
  weights: number[];
  /** Holdout metrics. */
  metrics: {
    trainN: number;
    testN: number;
    accuracy: number;
    precisionSl: number;
    recallSl: number;
    baselineSlRate: number;
  };
  /** Human SL-cause clusters from rule mining. */
  slCauses: SlCauseStat[];
  /** Human TP-win clusters. */
  tpWins: TpWinStat[];
  /** Module × market regime performance. */
  moduleMarket: ModuleMarketCell[];
  /** Compact playbook for runtime (prefer + avoid). */
  playbook: ScenarioBucket[];
  /** Module × hour (PKT) SL rates for quick lookup. */
  moduleHourSlRate: Record<string, { n: number; sl: number; rate: number }>;
  /** Suggested avoid thresholds. */
  thresholds: {
    /** Block if P(SL) >= this (prefer modules higher bar). */
    blockP: number;
    preferBlockP: number;
  };
}

export interface SlCauseStat {
  id: string;
  label: string;
  n: number;
  pctOfLosses: number;
  examples: string[];
  fix: string;
}

export interface LearnGateResult {
  ok: boolean;
  pSl: number;
  reason: string;
  matchedCauses: string[];
}
