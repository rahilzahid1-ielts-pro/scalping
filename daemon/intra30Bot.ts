/**
 * Intra30 bot — first strong of pattern → next M5 bar entry.
 * Multiple OPEN trades allowed; each new pattern can fire while others run.
 * TP1 $3 / TP2 $6 / SL $3; TP2 runner exits on weak candle.
 *
 * Local:  npm run intra30
 * Prod:   ENABLE_INTRA30_WORKER=1 required (default OFF).
 */
import { ASSETS } from "../src/config/assets";
import { fetchMultiTimeframe } from "../src/services/marketData";
import { fetchTradingViewQuote } from "../src/services/liveQuotes";
import {
  generateIntra30Signal,
  isWeakCandle,
} from "../src/strategies/intra30Engine";
import { dispatchTradeAlert } from "../src/services/notify";
import {
  getLiveIntra30Db,
  hasIntra30StrongBar,
  insertIntra30Row,
  listOpenIntra30,
  markIntra30Executed,
  signalToRow,
  updateIntra30Outcome,
  intra30RealizedR,
  type Intra30Outcome,
  type Intra30Row,
} from "../src/intra30/store";
import type { Candle } from "../src/types";
import {
  isFreshPendingEntryViable,
  pendingEntryState,
} from "../src/history/entryTouch";
import { entryTolerance } from "../src/utils/tradeSafety";

const TICK_MS = Number(process.env.INTRA30_TICK_MS) || 15_000;
const ASSET = "XAUUSD" as const;
/** Per-alert floor only — strongBarTime is the real dedupe across patterns. */
const COOLDOWN_MS = 20_000;
/** Reject Yahoo-futures ghosts vs OANDA desk mid (seen as ~$10+ entry skew). */
const MAX_ENTRY_LIVE_GAP = 4;

let workerRunning = false;
let lastAlertAt = 0;
/** All live OPEN trades (multi-signal). */
let openTrades: Intra30Row[] = [];
/** Per-trade TP1 reached flags (by row id). */
const tp1ReachedById = new Map<string, boolean>();

function log(...args: unknown[]) {
  console.log(`[intra30 ${new Date().toLocaleTimeString()}]`, ...args);
}

function priceOutcome(
  row: Intra30Row,
  bar: Candle,
): "SL_HIT" | "TP2_HIT" | "TP1_TOUCH" | null {
  const buy = row.direction === "BUY";
  const hitSl = buy ? bar.low <= row.sl : bar.high >= row.sl;
  const hitTp1 = buy ? bar.high >= row.tp1 : bar.low <= row.tp1;
  const hitTp2 = buy ? bar.high >= row.tp2 : bar.low <= row.tp2;
  if (hitSl && (hitTp1 || hitTp2)) return "SL_HIT";
  if (hitSl) return "SL_HIT";
  if (hitTp2) return "TP2_HIT";
  if (hitTp1) return "TP1_TOUCH";
  return null;
}

function syncOpenTradesFromDb(): void {
  const db = getLiveIntra30Db();
  openTrades = listOpenIntra30(db);
  const liveIds = new Set(openTrades.map((t) => t.id));
  for (const id of [...tp1ReachedById.keys()]) {
    if (!liveIds.has(id)) tp1ReachedById.delete(id);
  }
}

function manageOpenTrade(
  db: ReturnType<typeof getLiveIntra30Db>,
  trade: Intra30Row,
  last: Candle,
  prior: Candle | null,
): Intra30Row | null {
  let row = trade;

  if (!row.executedAt) {
    const state = pendingEntryState(
      row.direction,
      row.entry,
      row.sl,
      row.tp1,
      row.timestamp,
      last,
      entryTolerance(ASSETS[ASSET], "scalping", last.close),
    );
    if (state === "MISSED") {
      updateIntra30Outcome(db, row.id, "INVALIDATED", 0, Date.now());
      log("invalidated unexecuted stale lock", row.direction, row.entry);
      tp1ReachedById.delete(row.id);
      return null;
    }
    if (state === "EXECUTED") {
      const at = Date.now();
      markIntra30Executed(db, row.id, at);
      row = { ...row, executedAt: at };
      log("EXECUTED", row.direction, "@", row.entry);
    }
  }

  if (row.executedAt) {
    let outcome: Intra30Outcome | null = null;
    const px = priceOutcome(row, last);
    if (px === "SL_HIT") outcome = "SL_HIT";
    else if (px === "TP2_HIT") outcome = "TP2_HIT";
    else if (px === "TP1_TOUCH") tp1ReachedById.set(row.id, true);

    if (
      !outcome &&
      tp1ReachedById.get(row.id) &&
      prior &&
      isWeakCandle(prior)
    ) {
      outcome = "TP1_HIT";
    }

    if (outcome) {
      updateIntra30Outcome(
        db,
        row.id,
        outcome,
        intra30RealizedR(outcome),
        Date.now(),
      );
      log("resolved", row.direction, outcome, "@", row.entry);
      tp1ReachedById.delete(row.id);
      return null;
    }
  }

  return row;
}

async function tick(): Promise<void> {
  let liveQuote;
  try {
    liveQuote = await fetchTradingViewQuote(ASSET);
  } catch (e) {
    log("skip tick — TV quote failed:", e instanceof Error ? e.message : e);
    return;
  }

  const frames = await fetchMultiTimeframe(ASSET, "scalping", liveQuote.price, {
    rebaseToLive: true,
  });

  if (!frames.primary?.length) {
    log("no candles");
    return;
  }

  const db = getLiveIntra30Db();
  const last = frames.primary[frames.primary.length - 1];
  const prior =
    frames.primary.length >= 2
      ? frames.primary[frames.primary.length - 2]
      : null;
  const d = ASSETS[ASSET].decimals;
  const livePx = liveQuote.price;

  syncOpenTradesFromDb();
  const stillOpen: Intra30Row[] = [];
  for (const trade of openTrades) {
    const kept = manageOpenTrade(db, trade, last, prior);
    if (kept) stillOpen.push(kept);
  }
  openTrades = stillOpen;

  // Always scan for a NEW first-of-pattern setup (even while other trades OPEN).
  let sig;
  try {
    sig = generateIntra30Signal(ASSET, frames);
  } catch (e) {
    log("engine:", e instanceof Error ? e.message : e);
    return;
  }
  if (!sig) return;
  if (Date.now() - lastAlertAt < COOLDOWN_MS) return;
  if (hasIntra30StrongBar(db, sig.strongBarTime)) return;
  if (Math.abs(sig.entry - livePx) > MAX_ENTRY_LIVE_GAP) {
    log(
      "skip ghost entry",
      sig.entry.toFixed(d),
      "vs live",
      livePx.toFixed(d),
      `(gap $${Math.abs(sig.entry - livePx).toFixed(2)})`,
    );
    return;
  }
  if (
    !isFreshPendingEntryViable(
      sig.direction,
      sig.entry,
      sig.sl,
      sig.tp1,
      last,
      entryTolerance(ASSETS[ASSET], "scalping", last.close),
    )
  ) {
    return;
  }

  const row = signalToRow(sig, ASSET, "live");
  insertIntra30Row(db, row);
  openTrades = [row, ...openTrades];
  tp1ReachedById.set(row.id, false);
  lastAlertAt = Date.now();

  const openN = openTrades.length;
  const body = [
    `${sig.direction} @ ${sig.entry.toFixed(d)}`,
    `SL ${sig.sl.toFixed(d)} · TP1 ${sig.tp1.toFixed(d)} (+$3) · TP2 ${sig.tp2.toFixed(d)} (+$6)`,
    `Pehli strong → next bar · open trades now: ${openN}`,
    ...sig.reason.slice(0, 3),
  ].join("\n");

  log(
    "SIGNAL >>>",
    sig.direction,
    sig.entry,
    `conf=${sig.confidence}`,
    `open=${openN}`,
  );
  await dispatchTradeAlert({
    kind: "PLAN_LOCK",
    assetId: ASSET,
    mode: "intra30",
    side: sig.direction,
    title: "INTRA30 STRONG CANDLE",
    body,
    tagPrefix: "[Intra30]",
  });
}

export function startIntra30Worker(): void {
  if (workerRunning) {
    log("already running");
    return;
  }
  workerRunning = true;
  log(
    "started — Intra30 multi-signal (pehli strong → next bar; new pattern while OPEN OK)",
  );
  void (async () => {
    for (;;) {
      try {
        await tick();
      } catch (e) {
        log("tick fatal:", e instanceof Error ? e.message : e);
      }
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  })();
}

export function shouldAutoStartIntra30Worker(): boolean {
  const flag = String(process.env.ENABLE_INTRA30_WORKER ?? "0")
    .trim()
    .toLowerCase();
  return flag === "1" || flag === "true" || flag === "on";
}

async function main() {
  startIntra30Worker();
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("intra30Bot.ts");
if (isDirect) {
  void main();
}
