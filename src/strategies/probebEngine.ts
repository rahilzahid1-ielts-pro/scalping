/**
 * Probeb — next M5 candle direction (local, $0 API).
 *
 * Every closed M5 emits a lean for the *next* candle (always visible).
 * Quality tags strong/normal/weak; strong calls can alert.
 * Bar identity = floored M5 open (no live-rebase spam).
 */
import type { Candle } from "../types";
import { atr } from "./indicators";
import { computeRegime } from "./signalEngine";
import type { RegimeTag } from "../calibration/types";

export type ProbebSide = "BUY" | "SELL";
export type ProbebQuality = "strong" | "normal" | "weak";

export type ProbebPrediction = {
  side: ProbebSide;
  probabilityPct: number;
  confidencePct: number;
  bucket: string;
  sampleN: number;
  /** Closed M5 this call is based on. */
  barTime: number;
  /** The candle being predicted (barTime + 5m). */
  targetBarTime: number;
  quality: ProbebQuality;
  reason: string[];
};

export type ProbebFrames = {
  primary: Candle[];
  confirmation: Candle[];
  bias: Candle[];
};

export type ProbebDiagnose = {
  pass: boolean;
  waitReason: string;
  signal: ProbebPrediction | null;
};

const MIN_TRAIN = 80;
const LOOKBACK = 2000;
const MIN_BUCKET_N = 12;
const STRONG_EDGE_P = 0.58;
const STRONG_CONF = 40;
export const M5_MS = 5 * 60 * 1000;

/** Stable M5 open timestamp (ms). */
export function m5FloorMs(t: number): number {
  const ms = t < 1e12 ? t * 1000 : t;
  return Math.floor(ms / M5_MS) * M5_MS;
}

/**
 * Bars whose M5 slot is fully closed (strictly before the current wall-clock slot).
 */
export function closedM5Bars(primary: Candle[], now = Date.now()): Candle[] {
  const slot = m5FloorMs(now);
  const bySlot = new Map<number, Candle>();
  for (const c of primary) {
    const flo = m5FloorMs(c.time);
    if (flo >= slot) continue;
    bySlot.set(flo, { ...c, time: flo });
  }
  return [...bySlot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c);
}

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

/** 0..1 — big body + dollar range = chart "strong candle". */
function impulseScore(c: Candle): number {
  const range = c.high - c.low;
  if (!(range > 0) || !Number.isFinite(range)) return 0;
  const body = Math.abs(c.close - c.open);
  const frac = body / range;
  let s = 0;
  if (frac >= 0.5) s += 0.35;
  if (frac >= 0.65) s += 0.2;
  if (frac >= 0.8) s += 0.1;
  if (body >= 1.5) s += 0.15;
  if (body >= 3) s += 0.15;
  if (body >= 5) s += 0.1;
  return Math.min(1, s);
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

/**
 * Direction of the *next* M5 candle = that candle's body (green/red),
 * matching what the chart shows — NOT close-vs-prior-close (that marked
 * green bars as SELL / red as BUY and confused SAHI/GALAT).
 */
export function nextCandleSide(
  primary: Candle[],
  i: number,
): ProbebSide | null {
  if (i + 1 >= primary.length) return null;
  const b = primary[i + 1];
  if (!(Number.isFinite(b.close) && Number.isFinite(b.open))) return null;
  if (b.close > b.open) return "BUY";
  if (b.close < b.open) return "SELL";
  // Doji: fall back to close vs prior close.
  const a = primary[i];
  if (Number.isFinite(a.close)) {
    if (b.close > a.close) return "BUY";
    if (b.close < a.close) return "SELL";
  }
  return b.high - b.close >= b.close - b.low ? "SELL" : "BUY";
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

function momentumSide(
  streak: "up" | "dn" | "mix",
  localTrend: "up" | "dn" | "flat",
  htf: "up" | "dn" | "flat",
): { side: ProbebSide; p: number } {
  if (htf === "dn" || (htf === "flat" && (streak === "dn" || localTrend === "dn"))) {
    return { side: "SELL", p: 0.54 };
  }
  if (htf === "up" || (htf === "flat" && (streak === "up" || localTrend === "up"))) {
    return { side: "BUY", p: 0.54 };
  }
  if (streak === "dn") return { side: "SELL", p: 0.52 };
  if (streak === "up") return { side: "BUY", p: 0.52 };
  return { side: "BUY", p: 0.5 };
}

/**
 * Always returns a next-candle lean when enough closed M5 exists.
 */
export function diagnoseProbeb(
  frames: ProbebFrames,
  now = Date.now(),
): ProbebDiagnose {
  const closed = closedM5Bars(frames.primary, now);
  if (closed.length < MIN_TRAIN + 2) {
    return {
      pass: false,
      waitReason: "Probeb: closed M5 history kam hai",
      signal: null,
    };
  }

  const i = closed.length - 1;
  const atrExp = precomputeAtrExpand(closed);
  const htf = htfLean(frames.confirmation, frames.bias);
  const buckets = trainBuckets(closed, atrExp, htf);
  const bucket = bucketAt(closed, i, atrExp, htf);
  const stat = buckets.get(bucket) ?? { up: 0, dn: 0 };
  const n = stat.up + stat.dn;
  const streak = streakDir(closed, i);
  const localTrend = cheapTrend(closed, i);

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
    const mom = momentumSide(streak, localTrend, htf);
    const momUp = mom.side === "BUY" ? mom.p : 1 - mom.p;
    const w = n / MIN_BUCKET_N;
    const bucketP = n > 0 ? stat.up / n : base;
    pUp = w * bucketP + (1 - w) * 0.5 * (base + momUp);
  }

  const lastBd = bodyDir(closed[i]);
  const impulse = impulseScore(closed[i]);
  const atrOn = atrExp[i] === true;

  // Soft HTF nudge — never against a clear local body color.
  if (htf === "dn" && lastBd !== "up") pUp = Math.min(pUp, 0.48);
  if (htf === "up" && lastBd !== "dn") pUp = Math.max(pUp, 0.52);

  // Chart body wins: red closed M5 must not print BUY (HTF-up used to force weak BUY).
  if (lastBd === "dn") pUp = Math.min(pUp, 0.42);
  if (lastBd === "up") pUp = Math.max(pUp, 0.58);

  let side: ProbebSide = pUp >= 0.5 ? "BUY" : "SELL";
  let rawP = side === "BUY" ? pUp : 1 - pUp;

  if (lastBd === "dn" && side === "BUY") {
    side = "SELL";
    rawP = Math.max(0.58, 1 - pUp);
  } else if (lastBd === "up" && side === "SELL") {
    side = "BUY";
    rawP = Math.max(0.58, pUp);
  }

  // Strong candle in lean direction → lift win% / conf (was stuck ~52% / 6%).
  const impulseWithSide =
    (side === "BUY" && lastBd === "up") || (side === "SELL" && lastBd === "dn");
  if (impulseWithSide && impulse >= 0.35) {
    rawP = Math.max(rawP, 0.58 + 0.14 * impulse);
    if (atrOn && impulse >= 0.55) rawP = Math.max(rawP, 0.68);
    if (impulse >= 0.75) rawP = Math.max(rawP, 0.72);
  }

  const edge = Math.abs(rawP - 0.5);
  let confidencePct = confidenceFrom(Math.max(n, 1), edge);
  if (impulseWithSide && impulse >= 0.35) {
    confidencePct = Math.max(
      confidencePct,
      Math.round(28 + 50 * impulse + (atrOn ? 8 : 0)),
    );
  }
  confidencePct = Math.min(95, confidencePct);

  const probabilityPct = Math.round(rawP * 1000) / 10;
  const barTime = closed[i].time;
  const targetBarTime = barTime + M5_MS;

  const htfAgree =
    (side === "BUY" && htf === "up") || (side === "SELL" && htf === "dn");
  const momOk =
    (side === "BUY" && (streak === "up" || localTrend === "up" || lastBd === "up")) ||
    (side === "SELL" && (streak === "dn" || localTrend === "dn" || lastBd === "dn"));
  const fading =
    (side === "BUY" && lastBd === "dn") || (side === "SELL" && lastBd === "up");

  let quality: ProbebQuality = "weak";
  // Impulse path does not require HTF agree — local body already matches the
  // lean (strongImpulse). HTF-agree stayed on the bucket path so we don't mark
  // thin buckets STRONG against the higher TF.
  const strongImpulse =
    impulseWithSide && impulse >= 0.55 && atrOn && rawP >= 0.62 && confidencePct >= 40;
  // Desk / UI rule: win>60 + conf≥40 + local mom (not fade) → STRONG + auto.
  const deskStrong =
    !fading && momOk && rawP > 0.6 && confidencePct >= STRONG_CONF;
  if (
    deskStrong ||
    (!fading &&
      ((n >= MIN_BUCKET_N &&
        rawP >= STRONG_EDGE_P &&
        confidencePct >= STRONG_CONF &&
        htfAgree &&
        momOk) ||
        (strongImpulse && momOk)))
  ) {
    quality = "strong";
  } else if (
    !fading &&
    momOk &&
    ((n >= 8 && rawP >= 0.53) || (impulseWithSide && impulse >= 0.4 && rawP >= 0.58))
  ) {
    quality = "normal";
  }

  const note =
    quality === "strong"
      ? impulseWithSide && impulse >= 0.55
        ? "STRONG impulse candle"
        : "STRONG call"
      : quality === "normal"
        ? "Normal call"
        : fading
          ? `Weak (fade ${lastBd} bar)`
          : n < MIN_BUCKET_N
            ? `Weak (thin n=${n})`
            : `Weak (edge ${probabilityPct}%)`;

  return {
    pass: true,
    waitReason: "",
    signal: {
      side,
      probabilityPct,
      confidencePct,
      bucket,
      sampleN: n,
      barTime,
      targetBarTime,
      quality,
      reason: [
        `Agli candle → ${side}`,
        `${note} · win ${probabilityPct}% · conf ${confidencePct}%`,
        `HTF ${htf} · body ${lastBd} · impulse ${(impulse * 100).toFixed(0)}% · streak ${streak} · n=${n}`,
      ],
    },
  };
}

export function generateProbebPrediction(
  frames: ProbebFrames,
  now = Date.now(),
): ProbebPrediction | null {
  return diagnoseProbeb(frames, now).signal;
}

export function backtestProbebAccuracy(frames: ProbebFrames): {
  resolved: number;
  correct: number;
  accuracyPct: number | null;
} {
  const closed = closedM5Bars(frames.primary, Date.now() + M5_MS);
  if (closed.length < MIN_TRAIN + 10) {
    return { resolved: 0, correct: 0, accuracyPct: null };
  }
  let resolved = 0;
  let correct = 0;
  const end = closed.length - 1;
  const start = Math.max(MIN_TRAIN, end - 300);
  for (let i = start; i < end; i++) {
    const slice: ProbebFrames = {
      primary: closed.slice(0, i + 1),
      confirmation: frames.confirmation,
      bias: frames.bias,
    };
    const diag = diagnoseProbeb(slice, closed[i].time + M5_MS + 1000);
    const actual = nextCandleSide(closed, i);
    if (!diag.signal || !actual) continue;
    resolved += 1;
    if (diag.signal.side === actual) correct += 1;
  }
  return {
    resolved,
    correct,
    accuracyPct:
      resolved > 0 ? Math.round((correct / resolved) * 1000) / 10 : null,
  };
}
