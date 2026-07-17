import type { AssetId, TradeMode } from "../types";

/** Lifecycle status of the logged plan row */
export type SignalOutcome = "OPEN" | "TP1_HIT" | "SL_HIT" | "INVALIDATED";

/**
 * Primary win definition for calibration / Brier / UNTRUSTED:
 * WIN = TP1 touched before SL; LOSS = SL touched before TP1.
 */
export type OutcomeTp1 = "WIN" | "LOSS";

export type RegimeTag = "TREND_UP" | "TREND_DOWN" | "RANGE";

export interface LoggedSignal {
  id: string;
  timestamp: number;
  symbol: AssetId;
  mode: TradeMode;
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
  winChanceDisplayed: number;
  /** Empirical rate when calibration ready; null while measuring */
  winChanceCalibrated: number | null;
  confluencePct: number;
  smcScore: number;
  maScore: number;
  paScore: number;
  bullPts: number;
  bearPts: number;
  htfAligned: boolean;
  dailyBias: string;
  conflictingSignals: boolean;
  /** True when confidence + winChance were capped at 65% due to MA/SMC conflict */
  conflictCapped: boolean;
  /** Dedup fingerprint for frozen plan (UNIQUE in SQLite) */
  planKey: string;
  outcome: SignalOutcome;
  /** Null while OPEN / INVALIDATED before TP1 resolution */
  outcomeTp1: OutcomeTp1 | null;
  resolvedAt: number | null;
  /** R at TP1 exit (or -1 on SL before TP1) */
  realizedR: number | null;
  /**
   * Full-plan R under 3-part scaling (see computeRealizedRFull).
   * Null until outcomeTp1 is known; updated as TP2/TP3/BE-SL resolve.
   */
  realizedRFull: number | null;
  /** True when remaining size is flat (TP3 done or BE SL after TP1, or full SL) */
  fullPlanClosed: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  slAfterTp1: boolean;
  tp1HitAt: number | null;
  tp2HitAt: number | null;
  tp3HitAt: number | null;
  slAfterTp1At: number | null;
  atr14: number | null;
  atrPctOfPrice: number | null;
  regime: RegimeTag | null;
  resolveNote?: string;
}

/** @deprecated JSON file shape — only used during one-time migration */
export interface SignalStoreFile {
  version: 1;
  updatedAt: number;
  signals: LoggedSignal[];
}

export interface CalibrationBucketRow {
  bucket: string;
  bucketMin: number;
  bucketMax: number;
  claimedConfidenceMid: number;
  /** TP1 win rate = WIN / (WIN + LOSS) */
  actualWinRate: number | null;
  sampleSize: number;
  tpHits: number;
  slHits: number;
  /** Average realizedR_full among fullPlanClosed rows in bucket */
  avgRealizedRFull: number | null;
  brierScore: number | null;
  untrusted: boolean;
}

export const CONFIDENCE_BUCKETS = [
  { min: 50, max: 60, label: "50-60" },
  { min: 60, max: 70, label: "60-70" },
  { min: 70, max: 80, label: "70-80" },
  { min: 80, max: 90, label: "80-90" },
  { min: 90, max: 100, label: "90-100" },
] as const;

export const MIN_SAMPLES_FOR_CALIBRATION = 50;
/** Do not replace displayed win% until this much resolved history exists */
export const MIN_DAYS_BEFORE_DISPLAY_RECAL = 14;
/** Samples in a bucket must span at least this many distinct regime tags */
export const MIN_REGIMES_FOR_CALIBRATION = 2;
/** Samples in a bucket must span at least this many distinct calendar days */
export const MIN_CALENDAR_DAYS_FOR_CALIBRATION = 5;

export const CONFLICT_CAP_PCT = 65;
