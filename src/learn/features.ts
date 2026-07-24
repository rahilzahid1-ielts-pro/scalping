/**
 * Feature engineering for P(SL | context) model.
 */
import type { LearnFeatures, LearnModule, LearnRow } from "./types";

const MODULES: LearnModule[] = [
  "scalp",
  "intraday",
  "quick_scalp",
  "qs_pro",
  "pro",
  "intra30",
  "cipher_b",
  "fractal",
];

const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

export function karachiHour(ms: number): number {
  const d = new Date(ms + KARACHI_OFFSET_MS);
  return d.getUTCHours();
}

export function featureNames(): string[] {
  const names = [
    "bias",
    "side_sell",
    "hour_sin",
    "hour_cos",
    "session_asia", // 4–11 PKT
    "session_mid", // 11–16
    "session_eve", // 16–21
    "session_night", // 21–4
    "sl_tight", // <6
    "sl_mid", // 6–12
    "sl_fat", // >12
    "rr_lt_0_7",
    "rr_ok",
    "rr_gt_1_2",
  ];
  for (const m of MODULES) names.push(`mod_${m}`);
  names.push("stack_same_side_90m");
  names.push("after_tp_same_side_90m");
  return names;
}

function oneHotModule(module: LearnModule): number[] {
  return MODULES.map((m) => (m === module ? 1 : 0));
}

function sessionFlags(hour: number): [number, number, number, number] {
  if (hour >= 4 && hour < 11) return [1, 0, 0, 0];
  if (hour >= 11 && hour < 16) return [0, 1, 0, 0];
  if (hour >= 16 && hour < 21) return [0, 0, 1, 0];
  return [0, 0, 0, 1];
}

function slBucket(slMoney: number): [number, number, number] {
  if (slMoney < 6) return [1, 0, 0];
  if (slMoney <= 12) return [0, 1, 0];
  return [0, 0, 1];
}

function rrBucket(slMoney: number, tp1Money: number): [number, number, number] {
  const rr = slMoney > 0 ? tp1Money / slMoney : 1;
  if (rr < 0.7) return [1, 0, 0];
  if (rr > 1.2) return [0, 0, 1];
  return [0, 1, 0];
}

export type ContextFlags = {
  stackSameSide90m: boolean;
  afterTpSameSide90m: boolean;
};

export function extractFeatures(
  row: Pick<
    LearnRow,
    "module" | "side" | "executedAt" | "slMoney" | "tp1Money"
  >,
  ctx: ContextFlags = {
    stackSameSide90m: false,
    afterTpSameSide90m: false,
  },
): LearnFeatures {
  const hour = karachiHour(row.executedAt);
  const rad = (hour / 24) * Math.PI * 2;
  const [asia, mid, eve, night] = sessionFlags(hour);
  const [slT, slM, slF] = slBucket(row.slMoney);
  const [rrL, rrO, rrH] = rrBucket(row.slMoney, row.tp1Money);

  const vector = [
    1, // bias placeholder kept in vector for indexing; train uses separate bias
    row.side === "SELL" ? 1 : 0,
    Math.sin(rad),
    Math.cos(rad),
    asia,
    mid,
    eve,
    night,
    slT,
    slM,
    slF,
    rrL,
    rrO,
    rrH,
    ...oneHotModule(row.module),
    ctx.stackSameSide90m ? 1 : 0,
    ctx.afterTpSameSide90m ? 1 : 0,
  ];

  return { names: featureNames(), vector };
}

/** Build per-row context from chronological dataset. */
export function buildContextFlags(rows: LearnRow[]): ContextFlags[] {
  const WINDOW = 90 * 60 * 1000;
  return rows.map((row, i) => {
    let stack = false;
    let afterTp = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = rows[j];
      if (row.executedAt - prev.executedAt > WINDOW) break;
      if (prev.side !== row.side) continue;
      if (prev.module !== row.module && Math.abs(prev.entry - row.entry) <= 8) {
        stack = true;
      }
      if (
        (prev.outcome === "TP1_HIT" || prev.outcome === "TP2_HIT") &&
        prev.side === row.side
      ) {
        afterTp = true;
      }
    }
    return { stackSameSide90m: stack, afterTpSameSide90m: afterTp };
  });
}

export function labelOf(row: LearnRow): 0 | 1 {
  return row.outcome === "SL_HIT" ? 1 : 0;
}
