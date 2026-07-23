/**
 * Load live rows for `npm run calibrate -- --module=…` and adapt them to
 * LoggedSignal so the existing report / gate printers can run unchanged.
 *
 * Does NOT change calibration math, buckets, Brier, or unlock gates.
 */
import type { AssetId } from "../types";
import type { LoggedSignal, OutcomeTp1, RegimeTag, SignalOutcome } from "./types";
import { ensureDbMigrated, listAllSignals, SIGNAL_DB_PATH } from "./db";
import {
  getLiveQuickScalpDb,
  listQuickScalpRows,
  type QuickScalpRow,
} from "../quickScalp/store";
import { getLiveProDb, listProRows, type ProRow } from "../pro/store";
import { getLivePulseDb, listPulseRows, type PulseRow } from "../pulse/store";
import {
  getLiveIntra30Db,
  listIntra30Rows,
  type Intra30Row,
} from "../intra30/store";
import {
  getLiveStrategyDb,
  listStrategyRows,
  type StrategySignalRow,
} from "../strategyCompare/store";

/** CLI --module= values (plus aliases). */
export type CalibrateModuleId =
  | "main"
  | "scalp"
  | "intraday"
  | "quick_scalp"
  | "pro"
  | "qs_pro"
  | "ttrades_fractal"
  | "cipher_b"
  | "intra30";

export const CALIBRATE_MODULE_HELP = `
  main              data/signals.db → signals (Scalp + Intraday)  [default]
  scalp             signals WHERE mode=scalping
  intraday          signals WHERE mode=intraday
  quick_scalp       quick_scalp_signals
  pro               pro_signals
  qs_pro            pulse_signals (QS Pro / Pulse)
  ttrades_fractal   strategy_signals WHERE strategy=fractal
  cipher_b          strategy_signals WHERE strategy=cipher_b_clone
  intra30           intra30_signals
`;

const ALIASES: Record<string, CalibrateModuleId> = {
  main: "main",
  signals: "main",
  all: "main",
  scalp: "scalp",
  scalping: "scalp",
  intraday: "intraday",
  quick_scalp: "quick_scalp",
  quickscalp: "quick_scalp",
  qs: "quick_scalp",
  pro: "pro",
  qs_pro: "qs_pro",
  pulse: "qs_pro",
  qspro: "qs_pro",
  ttrades_fractal: "ttrades_fractal",
  fractal: "ttrades_fractal",
  ttrades: "ttrades_fractal",
  cipher_b: "cipher_b",
  cipher_b_clone: "cipher_b",
  cipherb: "cipher_b",
  cipher: "cipher_b",
  intra30: "intra30",
};

export function parseCalibrateModule(argv: string[]): CalibrateModuleId {
  const arg = argv.find((a) => a.startsWith("--module="));
  if (!arg) return "main";
  const raw = arg.split("=")[1]?.trim().toLowerCase() ?? "";
  const id = ALIASES[raw];
  if (!id) {
    throw new Error(
      `Unknown --module=${raw}. Allowed:${CALIBRATE_MODULE_HELP}`,
    );
  }
  return id;
}

export function moduleStoreLabel(id: CalibrateModuleId): string {
  switch (id) {
    case "main":
      return `${SIGNAL_DB_PATH} → table signals (all modes)`;
    case "scalp":
      return `${SIGNAL_DB_PATH} → table signals (mode=scalping)`;
    case "intraday":
      return `${SIGNAL_DB_PATH} → table signals (mode=intraday)`;
    case "quick_scalp":
      return `${SIGNAL_DB_PATH} → table quick_scalp_signals`;
    case "pro":
      return `${SIGNAL_DB_PATH} → table pro_signals`;
    case "qs_pro":
      return `${SIGNAL_DB_PATH} → table pulse_signals`;
    case "ttrades_fractal":
      return `${SIGNAL_DB_PATH} → table strategy_signals (strategy=fractal)`;
    case "cipher_b":
      return `${SIGNAL_DB_PATH} → table strategy_signals (strategy=cipher_b_clone)`;
    case "intra30":
      return `${SIGNAL_DB_PATH} → table intra30_signals`;
  }
}

function asAsset(symbol: string): AssetId {
  return (symbol || "XAUUSD") as AssetId;
}

function mapRegime(raw: string | null | undefined): RegimeTag | null {
  if (!raw) return null;
  const u = raw.toUpperCase();
  if (u === "TREND_UP" || u === "BULLISH" || u === "UP") return "TREND_UP";
  if (u === "TREND_DOWN" || u === "BEARISH" || u === "DOWN") return "TREND_DOWN";
  if (u === "RANGE" || u === "RANGING" || u === "CHOP") return "RANGE";
  return null;
}

/** Pull "conf 72%" (etc.) from stored reason JSON / text when no confidence column. */
export function parseConfidenceFromReason(reason: string): number | null {
  if (!reason) return null;
  try {
    const parsed = JSON.parse(reason) as unknown;
    if (Array.isArray(parsed)) {
      for (const line of parsed) {
        const m = String(line).match(/conf(?:idence)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%?/i);
        if (m) return Number(m[1]);
      }
    }
  } catch {
    /* plain text */
  }
  const m = reason.match(/conf(?:idence)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%?/i);
  return m ? Number(m[1]) : null;
}

function mapModuleOutcome(outcome: string): {
  outcome: SignalOutcome;
  outcomeTp1: OutcomeTp1 | null;
  fullPlanClosed: boolean;
} {
  if (outcome === "TP1_HIT" || outcome === "TP2_HIT") {
    return { outcome: "TP1_HIT", outcomeTp1: "WIN", fullPlanClosed: true };
  }
  if (outcome === "SL_HIT") {
    return { outcome: "SL_HIT", outcomeTp1: "LOSS", fullPlanClosed: true };
  }
  if (outcome === "OPEN") {
    return { outcome: "OPEN", outcomeTp1: null, fullPlanClosed: false };
  }
  return { outcome: "INVALIDATED", outcomeTp1: null, fullPlanClosed: true };
}

function blankLogged(partial: {
  id: string;
  timestamp: number;
  symbol: string;
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  confidence: number;
  dailyBias: string;
  regime: string | null;
  outcome: string;
  realizedR: number | null;
  resolvedAt: number | null;
  zoneTouchedAt?: number | null;
}): LoggedSignal {
  const mapped = mapModuleOutcome(partial.outcome);
  const conf = Number.isFinite(partial.confidence) ? partial.confidence : 0;
  return {
    id: partial.id,
    timestamp: partial.timestamp,
    symbol: asAsset(partial.symbol),
    // Modules are not main TradeMode — filler so LoggedSignal type + printers work.
    mode: "scalping",
    side: partial.side,
    entry: partial.entry,
    sl: partial.sl,
    tp1: partial.tp1,
    tp2: partial.tp2,
    tp3: partial.tp2,
    confidence: conf,
    winChanceDisplayed: conf,
    winChanceCalibrated: null,
    confluencePct: 0,
    smcScore: 0,
    maScore: 0,
    paScore: 0,
    bullPts: 0,
    bearPts: 0,
    htfAligned: false,
    dailyBias: partial.dailyBias || "",
    conflictingSignals: false,
    conflictCapped: false,
    planKey: partial.id,
    outcome: mapped.outcome,
    outcomeTp1: mapped.outcomeTp1,
    resolvedAt: partial.resolvedAt,
    realizedR: partial.realizedR,
    realizedRFull: partial.realizedR,
    fullPlanClosed: mapped.fullPlanClosed,
    tp2Hit: partial.outcome === "TP2_HIT",
    tp3Hit: false,
    slAfterTp1: false,
    tp1HitAt:
      mapped.outcomeTp1 === "WIN" ? partial.resolvedAt : null,
    tp2HitAt: partial.outcome === "TP2_HIT" ? partial.resolvedAt : null,
    tp3HitAt: null,
    slAfterTp1At: null,
    atr14: null,
    atrPctOfPrice: null,
    regime: mapRegime(partial.regime),
    zoneTouchedAt: partial.zoneTouchedAt ?? null,
    wouldHaveHitSlFirst: null,
    liquiditySweepDetectedAt: null,
    liquiditySweepThenRegimeFlipped: null,
    trendConfirmedAt: null,
    trendDurationBars: null,
  };
}

function fromQuickScalp(r: QuickScalpRow): LoggedSignal {
  const conf = parseConfidenceFromReason(r.reason) ?? 0;
  return blankLogged({
    id: r.id,
    timestamp: r.timestamp,
    symbol: r.symbol,
    side: r.direction,
    entry: r.entry,
    sl: r.sl,
    tp1: r.tp1,
    tp2: r.tp2,
    confidence: conf,
    dailyBias: r.dailyTrend,
    regime: null,
    outcome: r.outcome,
    realizedR: r.realizedR,
    resolvedAt: r.resolvedAt,
    zoneTouchedAt: r.executedAt,
  });
}

function fromPro(r: ProRow): LoggedSignal {
  return blankLogged({
    id: r.id,
    timestamp: r.timestamp,
    symbol: r.symbol,
    side: r.direction,
    entry: r.entry,
    sl: r.sl,
    tp1: r.tp1,
    tp2: r.tp2,
    confidence: r.confidence,
    dailyBias: r.dailyBias,
    regime: r.regime,
    outcome: r.outcome,
    realizedR: r.realizedR,
    resolvedAt: r.resolvedAt,
    zoneTouchedAt: r.executedAt,
  });
}

function fromPulse(r: PulseRow): LoggedSignal {
  return blankLogged({
    id: r.id,
    timestamp: r.timestamp,
    symbol: r.symbol,
    side: r.direction,
    entry: r.entry,
    sl: r.sl,
    tp1: r.tp1,
    tp2: r.tp2,
    confidence: r.confidence,
    dailyBias: r.dailyBias,
    regime: r.regime,
    outcome: r.outcome,
    realizedR: r.realizedR,
    resolvedAt: r.resolvedAt,
    zoneTouchedAt: r.executedAt,
  });
}

function fromIntra30(r: Intra30Row): LoggedSignal {
  return blankLogged({
    id: r.id,
    timestamp: r.timestamp,
    symbol: r.symbol,
    side: r.direction,
    entry: r.entry,
    sl: r.sl,
    tp1: r.tp1,
    tp2: r.tp2,
    confidence: r.confidence,
    dailyBias: r.dailyBias,
    regime: r.regime,
    outcome: r.outcome,
    realizedR: r.realizedR,
    resolvedAt: r.resolvedAt,
    zoneTouchedAt: r.executedAt,
  });
}

function fromStrategy(r: StrategySignalRow): LoggedSignal {
  const conf = parseConfidenceFromReason(r.reason) ?? 0;
  return blankLogged({
    id: r.id,
    timestamp: r.time,
    symbol: r.symbol,
    side: r.direction,
    entry: r.entry,
    sl: r.sl,
    tp1: r.tp1,
    tp2: r.tp2,
    confidence: conf,
    dailyBias: "",
    regime: null,
    outcome: r.outcome,
    realizedR: r.realizedR,
    resolvedAt: r.resolvedAt,
    zoneTouchedAt: r.executedAt,
  });
}

export interface ModuleLoadResult {
  module: CalibrateModuleId;
  storeLabel: string;
  /** Raw table row count before day window filter (live). */
  tableRowCount: number;
  signals: LoggedSignal[];
}

/** Open the right live table(s) and return LoggedSignal rows for calibration. */
export function loadModuleSignals(module: CalibrateModuleId): ModuleLoadResult {
  ensureDbMigrated();
  const storeLabel = moduleStoreLabel(module);

  if (module === "main" || module === "scalp" || module === "intraday") {
    const all = listAllSignals();
    const filtered =
      module === "main"
        ? all
        : module === "scalp"
          ? all.filter((s) => s.mode === "scalping")
          : all.filter((s) => s.mode === "intraday");
    return {
      module,
      storeLabel,
      tableRowCount: filtered.length,
      signals: filtered,
    };
  }

  if (module === "quick_scalp") {
    const rows = listQuickScalpRows(getLiveQuickScalpDb());
    return {
      module,
      storeLabel,
      tableRowCount: rows.length,
      signals: rows.map(fromQuickScalp),
    };
  }

  if (module === "pro") {
    const rows = listProRows(getLiveProDb());
    return {
      module,
      storeLabel,
      tableRowCount: rows.length,
      signals: rows.map(fromPro),
    };
  }

  if (module === "qs_pro") {
    const rows = listPulseRows(getLivePulseDb());
    return {
      module,
      storeLabel,
      tableRowCount: rows.length,
      signals: rows.map(fromPulse),
    };
  }

  if (module === "intra30") {
    const rows = listIntra30Rows(getLiveIntra30Db());
    return {
      module,
      storeLabel,
      tableRowCount: rows.length,
      signals: rows.map(fromIntra30),
    };
  }

  if (module === "ttrades_fractal") {
    const rows = listStrategyRows(getLiveStrategyDb(), "fractal");
    return {
      module,
      storeLabel,
      tableRowCount: rows.length,
      signals: rows.map(fromStrategy),
    };
  }

  // cipher_b
  const rows = listStrategyRows(getLiveStrategyDb(), "cipher_b_clone");
  return {
    module,
    storeLabel,
    tableRowCount: rows.length,
    signals: rows.map(fromStrategy),
  };
}
