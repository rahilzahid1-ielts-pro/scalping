/**
 * Probeb — next M5 candle direction probability (local, $0 API).
 *
 * Empirical buckets from recent history: just-closed bar shape + ATR expand +
 * short trend lean → P(next close up vs down). Measured frequency, not LLM.
 */
import type { Candle } from "../types";
import { atr } from "./indicators";
import { computeRegime } from "./signalEngine";
import type { RegimeTag } from "../calibration/types";

export type ProbebSide = "BUY" | "SELL";

export type ProbebPrediction = {
  side: ProbebSide;
  probabilityPct: number;
  confidencePct: number;
  bucket: string;
  sampleN: number;
  barTime: number;
  reason: string[];
};

export type ProbebFrames = {
  primary: Candle[];
  confirmation: Candle[];
  bias: Candle[];
};

const MIN_TRAIN = 80;
const LOOKBACK = 2000;
const MIN_BUCKET_N = 12;

function closeZone(c: Candle): "lo" | "mid" | "hi" {
  const range = c.high - c.low;
  if (!(range > 0)) return "mid";
  const pos = (c.close - c.low) / range;
  if (pos >= 0.66) return "hi";
  if (pos <= 0.33) return "lo";
  return "mid";
}

function bodyDir(c: Candle): "up" | "dn" | "doji" {
  const body = c.close - c.open;
  const range = c.high - c.low;
  if (!(range > 0) || Math.abs(body) / range < 0.15) return "doji";
  return body > 0 ? "up" : "dn";
}

function streakDir(primary: Candle[], i: number): "up" | "dn" | "mix" {
  if (i < 2) return "mix";
  const a = primary[i].close > primary[i - 1].close;
  const b = primary[i - 1].close > primary[i - 2].close;
  if (a && b) return "up";
  if (!a && !b) return "dn";
  return "mix";
}

function cheapTrend(primary: Candle[], i: number): "up" | "dn" | "flat" {
  if (i < 20) return "flat";
  const a = primary[i - 20].close;
  const b = primary[i].close;
  if (!(Number.isFinite(a) && Number.isFinite(b)) || a === 0) return "flat";
  const move = ((b - a) / a) * 100;
  if (move >= 0.08) return "up";
  if (move <= -0.08) return "dn";
  return "flat";
}

function htfLean(confirmation: Candle[], bias: Candle[]): "up" | "dn" | "flat" {
  const tags: RegimeTag[] = [];
  if (confirmation.length >= 30) tags.push(computeRegime(confirmation));
  if (bias.length >= 30) tags.push(computeRegime(bias));
  const up = tags.filter((t) => t === "TREND_UP").length;
  const dn = tags.filter((t) => t === "TREND_DOWN").length;
  if (up > dn) return "up";
  if (dn > up) return "dn";
  return "flat";
}

function precomputeAtrExpand(primary: Candle[]): boolean[] {
  const a = atr(primary, 14);
  const out = new Array(primary.length).fill(false);
  for (let i = 0; i < primary.length; i++) {
    if (i < 34 || a.length <= i) continue;
    const cur = a[i];
    let sum = 0;
    let n = 0;
    for (let j = i - 20; j < i; j++) {
      if (j >= 0 && Number.isFinite(a[j])) {
        sum += a[j];
        n += 1;
      }
    }
    if (n > 0 && sum / n > 0 && cur > 1.2 * (sum / n)) out[i] = true;
  }
  return out;
}

function bucketAt(
  primary: Candle[],
  i: number,
  atrExp: boolean[],
  htf: "up" | "dn" | "flat",
): string {
  const c = primary[i];
  const bd = bodyDir(c);
  const cz = closeZone(c);
  const ax = atrExp[i] ? "1" : "0";
  const st = streakDir(primary, i);
  const tr = cheapTrend(primary, i);
  const agree =
    bd === "doji" || htf === "flat"
      ? "na"
      : (bd === "up" && htf === "up") || (bd === "dn" && htf === "dn")
        ? "yes"
        : (bd === "up" && htf === "dn") || (bd === "dn" && htf === "up")
          ? "no"
          : "na";
  return `${bd}|${cz}|${ax}|${st}|${tr}|${agree}`;
}

export function nextCandleSide(
  primary: Candle[],
  i: number,
): ProbebSide | null {
  if (i + 1 >= primary.length) return null;
  const a = primary[i].close;
  const b = primary[i + 1].close;
  if (!(Number.isFinite(a) && Number.isFinite(b)) || a === b) return null;
  return b > a ? "BUY" : "SELL";
}

type BucketStat = { up: number; dn: number };

function trainBuckets(
  primary: Candle[],
  atrExp: boolean[],
  htf: "up" | "dn" | "flat",
): Map<string, BucketStat> {
  const map = new Map<string, BucketStat>();
  const end = primary.length - 1;
  const start = Math.max(40, end - LOOKBACK);
  for (let i = start; i < end; i++) {
    const outcome = nextCandleSide(primary, i);
    if (!outcome) continue;
    const key = bucketAt(primary, i, atrExp, htf);
    let s = map.get(key);
    if (!s) {
      s = { up: 0, dn: 0 };
      map.set(key, s);
    }
    if (outcome === "BUY") s.up += 1;
    else s.dn += 1;
  }
  return map;
}

function confidenceFrom(n: number, edge: number): number {
  const nScore = Math.min(1, n / 80);
  const eScore = Math.min(1, edge / 0.2);
  return Math.round(100 * (0.45 * nScore + 0.55 * eScore));
}

export function generateProbebPrediction(
  frames: ProbebFrames,
): ProbebPrediction | null {
  const { primary, confirmation, bias } = frames;
  if (primary.length < MIN_TRAIN + 2) return null;

  const i = primary.length - 1;
  const atrExp = precomputeAtrExpand(primary);
  const htf = htfLean(confirmation, bias);
  const buckets = trainBuckets(primary, atrExp, htf);
  const bucket = bucketAt(primary, i, atrExp, htf);
  const stat = buckets.get(bucket) ?? { up: 0, dn: 0 };
  const n = stat.up + stat.dn;

  let pUp: number;
  if (n >= MIN_BUCKET_N) {
    pUp = stat.up / n;
  } else {
    let gUp = 0;
    let gN = 0;
    for (const s of buckets.values()) {
      gUp += s.up;
      gN += s.up + s.dn;
    }
    const base = gN > 0 ? gUp / gN : 0.5;
    const w = n / MIN_BUCKET_N;
    pUp = w * (n > 0 ? stat.up / n : base) + (1 - w) * base;
  }

  const side: ProbebSide = pUp >= 0.5 ? "BUY" : "SELL";
  const rawP = side === "BUY" ? pUp : 1 - pUp;
  const probabilityPct = Math.round(rawP * 1000) / 10;
  const confidencePct = confidenceFrom(Math.max(n, 1), Math.abs(pUp - 0.5));

  return {
    side,
    probabilityPct,
    confidencePct,
    bucket,
    sampleN: n,
    barTime: primary[i].time,
    reason: [
      `Bucket ${bucket}`,
      n >= MIN_BUCKET_N
        ? `n=${n} · P(up)=${(pUp * 100).toFixed(1)}%`
        : `thin bucket n=${n} · shrunk to base`,
      `Next candle lean ${side} @ ${probabilityPct}% · conf ${confidencePct}%`,
    ],
  };
}

export function backtestProbebAccuracy(frames: ProbebFrames): {
  resolved: number;
  correct: number;
  accuracyPct: number | null;
} {
  const { primary, confirmation, bias } = frames;
  if (primary.length < MIN_TRAIN + 10) {
    return { resolved: 0, correct: 0, accuracyPct: null };
  }
  const atrExp = precomputeAtrExpand(primary);
  const htf = htfLean(confirmation, bias);
  const end = primary.length - 1;
  const testStart = Math.max(MIN_TRAIN, end - 400);
  const buckets = trainBuckets(primary.slice(0, testStart + 1), atrExp, htf);

  let resolved = 0;
  let correct = 0;
  for (let i = testStart; i < end; i++) {
    const key = bucketAt(primary, i, atrExp, htf);
    const stat = buckets.get(key) ?? { up: 0, dn: 0 };
    const n = stat.up + stat.dn;
    if (n < 5) continue;
    const pUp = stat.up / n;
    const side: ProbebSide = pUp >= 0.5 ? "BUY" : "SELL";
    const actual = nextCandleSide(primary, i);
    if (!actual) continue;
    resolved += 1;
    if (side === actual) correct += 1;
  }
  return {
    resolved,
    correct,
    accuracyPct:
      resolved > 0 ? Math.round((correct / resolved) * 1000) / 10 : null,
  };
}
