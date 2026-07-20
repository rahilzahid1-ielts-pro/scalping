import { existsSync, readFileSync } from "node:fs";
import type { Candle } from "../types";

/** ForexSB / Dukascopy Premium Data JSON (minutes since 2000-01-01 UTC). */
const FOREXSB_EPOCH_MS = Date.UTC(2000, 0, 1);
const M5_MS = 5 * 60 * 1000;

export interface DataQualityReport {
  bars: number;
  firstIso: string;
  lastIso: string;
  periodMinutes: number;
  duplicates: number;
  nonMonotonic: number;
  /** Intraday gaps > 1 bar (weekend/holiday gaps excluded) */
  suspiciousGaps: number;
  gapRanges: { from: string; to: string; missingBars: number }[];
  fileSpreadPoints: number | null;
  filePoint: number | null;
  impliedFileSpreadPrice: number | null;
}

export interface LoadedSeries {
  symbol: string;
  candles: Candle[];
  periodMinutes: number;
  quality: DataQualityReport;
  timezoneNote: string;
}

interface ForexSbJson {
  symbol?: string;
  period?: number;
  bars?: number;
  spread?: number;
  point?: number;
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume?: number[];
}

function isWeekendGap(prevOpenMs: number, nextOpenMs: number): boolean {
  // Gap spanning Fri→Mon (or holiday islands): if calendar days skipped ≥ 2 and
  // either side is near weekend, treat as normal.
  const daySpan = (nextOpenMs - prevOpenMs) / (24 * 60 * 60 * 1000);
  if (daySpan < 1.5) return false;
  const prevDay = new Date(prevOpenMs).getUTCDay(); // 0 Sun .. 5 Fri 6 Sat
  const nextDay = new Date(nextOpenMs).getUTCDay();
  return prevDay === 5 || prevDay === 6 || nextDay === 0 || nextDay === 1 || daySpan >= 2;
}

function validateAndBuild(
  symbol: string,
  periodMinutes: number,
  timesMin: number[],
  open: number[],
  high: number[],
  low: number[],
  close: number[],
  volume: number[],
  fileSpread: number | null,
  filePoint: number | null,
): LoadedSeries {
  const n = timesMin.length;
  if (![open, high, low, close].every((a) => a.length === n)) {
    throw new Error("[backtest] OHLC array length mismatch");
  }

  const candles: Candle[] = [];
  let duplicates = 0;
  let nonMonotonic = 0;
  const gapRanges: DataQualityReport["gapRanges"] = [];
  let suspiciousGaps = 0;
  const step = periodMinutes;

  for (let i = 0; i < n; i++) {
    const openMs = FOREXSB_EPOCH_MS + timesMin[i] * 60 * 1000;
    if (i > 0) {
      const prevMin = timesMin[i - 1];
      const prevMs = FOREXSB_EPOCH_MS + prevMin * 60 * 1000;
      if (timesMin[i] === prevMin) {
        duplicates += 1;
        continue;
      }
      if (timesMin[i] < prevMin) {
        nonMonotonic += 1;
        continue;
      }
      const expected = prevMin + step;
      if (timesMin[i] > expected) {
        const missing = Math.round((timesMin[i] - prevMin) / step) - 1;
        if (missing > 0 && !isWeekendGap(prevMs, openMs)) {
          suspiciousGaps += 1;
          if (gapRanges.length < 40) {
            gapRanges.push({
              from: new Date(prevMs).toISOString(),
              to: new Date(openMs).toISOString(),
              missingBars: missing,
            });
          }
        }
      }
    }

    const o = open[i];
    const h = high[i];
    const l = low[i];
    const c = close[i];
    if (![o, h, l, c].every((x) => Number.isFinite(x))) continue;

    candles.push({
      time: openMs,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: volume[i] ?? 0,
    });
  }

  if (candles.length < 500) {
    throw new Error(`[backtest] Too few usable bars (${candles.length})`);
  }

  const quality: DataQualityReport = {
    bars: candles.length,
    firstIso: new Date(candles[0].time).toISOString(),
    lastIso: new Date(candles[candles.length - 1].time).toISOString(),
    periodMinutes,
    duplicates,
    nonMonotonic,
    suspiciousGaps,
    gapRanges,
    fileSpreadPoints: fileSpread,
    filePoint,
    impliedFileSpreadPrice:
      fileSpread != null && filePoint != null ? fileSpread * filePoint : null,
  };

  return {
    symbol,
    candles,
    periodMinutes,
    quality,
    timezoneNote:
      "ForexSB time[] = minutes since 2000-01-01 UTC (bar OPEN). Normalized to UTC ms — same epoch basis as live Yahoo/Binance timestamps.",
  };
}

/** Load ForexSB-style M5 JSON (confirmed from XAUUSD_M5.json sample). */
export function loadForexSbJson(path: string): LoadedSeries {
  if (!existsSync(path)) throw new Error(`[backtest] File not found: ${path}`);
  let parsed: ForexSbJson;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ForexSbJson;
  } catch (e) {
    throw new Error(
      `[backtest] Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!Array.isArray(parsed.time) || !Array.isArray(parsed.open)) {
    throw new Error(
      "[backtest] Unrecognized format — expected ForexSB JSON with time/open/high/low/close arrays",
    );
  }

  const period = Number(parsed.period) || 5;
  if (period !== 5 && period !== 1) {
    console.warn(
      `[backtest] period=${period} — expected 1 or 5 (base TF). HTF still resampled from this series.`,
    );
  }

  return validateAndBuild(
    String(parsed.symbol ?? "XAUUSD"),
    period,
    parsed.time,
    parsed.open,
    parsed.high,
    parsed.low,
    parsed.close,
    parsed.volume ?? parsed.time.map(() => 0),
    parsed.spread ?? null,
    parsed.point ?? null,
  );
}

/**
 * MT5 / broker CSV: `Date;Open;High;Low;Close;Volume`
 * Date like `2004.06.11 07:15` (broker local wall-clock, treated as UTC for series math).
 */
export function loadMt5Csv(path: string, periodMinutesHint?: number): LoadedSeries {
  if (!existsSync(path)) throw new Error(`[backtest] File not found: ${path}`);
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error(`[backtest] CSV empty: ${path}`);

  const header = lines[0].toLowerCase();
  if (!header.includes("date") || !header.includes("open") || !header.includes("close")) {
    throw new Error(
      `[backtest] Unexpected CSV header (want Date;Open;High;Low;Close;Volume): ${lines[0]}`,
    );
  }

  const timesMin: number[] = [];
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];

  for (let li = 1; li < lines.length; li++) {
    const parts = lines[li].split(";");
    if (parts.length < 5) continue;
    const rawDate = parts[0].trim();
    // 2004.06.11 07:15  or  2004.06.11
    const m = /^(\d{4})\.(\d{2})\.(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(rawDate);
    if (!m) continue;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const hh = Number(m[4] ?? 0);
    const mm = Number(m[5] ?? 0);
    const ss = Number(m[6] ?? 0);
    const ms = Date.UTC(y, mo, d, hh, mm, ss);
    if (!Number.isFinite(ms)) continue;

    const o = Number(parts[1]);
    const h = Number(parts[2]);
    const l = Number(parts[3]);
    const c = Number(parts[4]);
    const v = parts.length > 5 ? Number(parts[5]) : 0;
    if (![o, h, l, c].every((x) => Number.isFinite(x))) continue;

    timesMin.push(Math.round((ms - FOREXSB_EPOCH_MS) / 60_000));
    open.push(o);
    high.push(h);
    low.push(l);
    close.push(c);
    volume.push(Number.isFinite(v) ? v : 0);
  }

  if (timesMin.length < 500) {
    throw new Error(`[backtest] Too few CSV bars (${timesMin.length}) in ${path}`);
  }

  // Infer period from median step between bars (robust to weekends).
  let periodMinutes = periodMinutesHint ?? 5;
  if (periodMinutesHint == null && timesMin.length >= 3) {
    const steps: number[] = [];
    for (let i = 1; i < Math.min(timesMin.length, 5000); i++) {
      const dt = timesMin[i] - timesMin[i - 1];
      if (dt > 0 && dt <= 60 * 24 * 7) steps.push(dt);
    }
    steps.sort((a, b) => a - b);
    if (steps.length) periodMinutes = steps[Math.floor(steps.length / 2)] || 5;
  }

  const base = path.replace(/\\/g, "/").split("/").pop() ?? "XAUUSD";
  const loaded = validateAndBuild(
    "XAUUSD",
    periodMinutes,
    timesMin,
    open,
    high,
    low,
    close,
    volume,
    null,
    null,
  );
  loaded.timezoneNote =
    `MT5 CSV (${base}): Date;OHLCV — bar OPEN timestamps treated as UTC wall-clock. ` +
    `HTF for engines is still resampled from this base series (no look-ahead).`;
  return loaded;
}

/**
 * Load historical OHLC. Supports ForexSB JSON and MT5 semicolon CSV.
 */
export function loadHistoricalFile(path: string): LoadedSeries {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return loadForexSbJson(path);
  if (lower.endsWith(".csv")) {
    // Prefer M5 for walk-forward; other TFs loadable but engines expect M5 base.
    const hint = /_1m_/i.test(path)
      ? 1
      : /_5m_/i.test(path)
        ? 5
        : /_15m_/i.test(path)
          ? 15
          : /_30m_/i.test(path)
            ? 30
            : /_1h_/i.test(path)
              ? 60
              : /_4h_/i.test(path)
                ? 240
                : /_1d_/i.test(path)
                  ? 1440
                  : /_1w_/i.test(path)
                    ? 10080
                    : /_1month_/i.test(path)
                      ? 43200
                      : undefined;
    return loadMt5Csv(path, hint);
  }
  throw new Error(
    `[backtest] Unsupported file type: ${path}\n` +
      `  Provide ForexSB JSON (e.g. XAUUSD_M5.json) or MT5 CSV (Date;Open;High;Low;Close;Volume).`,
  );
}

export function filterLastDays(candles: Candle[], days: number): Candle[] {
  if (days <= 0 || candles.length === 0) return candles;
  const last = candles[candles.length - 1].time;
  const cutoff = last - days * 24 * 60 * 60 * 1000;
  // Keep warmup history before cutoff so EMA200/daily still warm
  const warmupMs = 120 * 24 * 60 * 60 * 1000; // 120d warmup before window
  const start = cutoff - warmupMs;
  return candles.filter((c) => c.time >= start);
}

export function windowStartIndex(candles: Candle[], days: number): number {
  if (days <= 0 || candles.length === 0) return 0;
  const last = candles[candles.length - 1].time;
  const cutoff = last - days * 24 * 60 * 60 * 1000;
  const idx = candles.findIndex((c) => c.time >= cutoff);
  return idx < 0 ? 0 : idx;
}

export { M5_MS };
