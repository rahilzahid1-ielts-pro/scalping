/**
 * Intra30 bot — strong candle → next M5 bar entry.
 * TP1 $3 / TP2 $6 / SL $3; TP2 runner exits on weak candle.
 *
 * Local:  npm run intra30
 * Prod:   ENABLE_INTRA30_WORKER=1 required (default OFF).
 */
import { ASSETS } from "../src/config/assets";
import { fetchMultiTimeframe } from "../src/services/marketData";
import {
  generateIntra30Signal,
  isWeakCandle,
} from "../src/strategies/intra30Engine";
import { dispatchTradeAlert } from "../src/services/notify";
import {
  getLiveIntra30Db,
  getOpenOrLatestIntra30,
  hasIntra30StrongBar,
  insertIntra30Row,
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
const COOLDOWN_MS = 5 * 60 * 1000;

let workerRunning = false;
let lastAlertAt = 0;
let openTrade: Intra30Row | null = null;
/** After TP1 price touch, runner stays open until TP2 or weak candle. */
let tp1Reached = false;

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

async function tick(): Promise<void> {
  const frames = await fetchMultiTimeframe(ASSET, "scalping", undefined, {
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

  if (!openTrade) {
    const resumed = getOpenOrLatestIntra30(db);
    if (resumed?.outcome === "OPEN") {
      openTrade = resumed;
      tp1Reached = false;
      log("resumed OPEN", openTrade.direction, openTrade.entry);
    }
  }

  if (openTrade) {
    if (!openTrade.executedAt) {
      const state = pendingEntryState(
        openTrade.direction,
        openTrade.entry,
        openTrade.sl,
        openTrade.tp1,
        openTrade.timestamp,
        last,
        entryTolerance(ASSETS[ASSET], "scalping", last.close),
      );
      if (state === "MISSED") {
        updateIntra30Outcome(db, openTrade.id, "INVALIDATED", 0, Date.now());
        log(
          "invalidated unexecuted stale lock",
          openTrade.direction,
          openTrade.entry,
        );
        openTrade = null;
        tp1Reached = false;
      } else if (state === "EXECUTED") {
        const at = Date.now();
        markIntra30Executed(db, openTrade.id, at);
        openTrade = { ...openTrade, executedAt: at };
        log("EXECUTED", openTrade.direction, "@", openTrade.entry);
      }
    }
    if (openTrade?.executedAt) {
      let outcome: Intra30Outcome | null = null;
      const px = priceOutcome(openTrade, last);
      if (px === "SL_HIT") outcome = "SL_HIT";
      else if (px === "TP2_HIT") outcome = "TP2_HIT";
      else if (px === "TP1_TOUCH") tp1Reached = true;

      // Runner: after TP1, close on weak closed candle (TP1 banked).
      if (!outcome && tp1Reached && prior && isWeakCandle(prior)) {
        outcome = "TP1_HIT";
      }

      if (outcome) {
        updateIntra30Outcome(
          db,
          openTrade.id,
          outcome,
          intra30RealizedR(outcome),
          Date.now(),
        );
        log("resolved", openTrade.direction, outcome);
        openTrade = null;
        tp1Reached = false;
      }
    }
  }

  if (openTrade) return;

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
  openTrade = row;
  tp1Reached = false;
  lastAlertAt = Date.now();

  const body = [
    `${sig.direction} @ ${sig.entry.toFixed(d)}`,
    `SL ${sig.sl.toFixed(d)} · TP1 ${sig.tp1.toFixed(d)} (+$3) · TP2 ${sig.tp2.toFixed(d)} (+$6)`,
    `Strong candle → next bar · TP2 until weak candle`,
    ...sig.reason.slice(0, 3),
  ].join("\n");

  log("SIGNAL >>>", sig.direction, sig.entry, `conf=${sig.confidence}`);
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
    "started — Intra30 (strong candle → next bar, TP1 $3 / TP2 $6 / weak exit)",
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
