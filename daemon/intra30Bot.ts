/**
 * Intra30 alert bot — Intraday generateSignal copy with fixed TP $3 / SL $6.
 * Isolated from daemon/alertBot.ts plan locks.
 *
 * Local:  npm run intra30
 * Prod:   ENABLE_INTRA30_WORKER=1 required (default OFF — no Railway auto-start
 *         until Step-2 session-lock backtest is approved).
 */
import { ASSETS } from "../src/config/assets";
import { fetchMultiTimeframe } from "../src/services/marketData";
import { generateIntra30Signal } from "../src/strategies/intra30Engine";
import { dispatchTradeAlert } from "../src/services/notify";
import {
  getLiveIntra30Db,
  getOpenOrLatestIntra30,
  insertIntra30Row,
  markIntra30Executed,
  signalToRow,
  updateIntra30Outcome,
  intra30RealizedR,
  type Intra30Row,
} from "../src/intra30/store";
import type { Candle } from "../src/types";
import {
  isFreshPendingEntryViable,
  pendingEntryState,
} from "../src/history/entryTouch";
import { entryTolerance } from "../src/utils/tradeSafety";

const TICK_MS = Number(process.env.INTRA30_TICK_MS) || 60_000;
const ASSET = "XAUUSD" as const;
const COOLDOWN_MS = 3 * 60 * 60 * 1000;

let workerRunning = false;
let lastAlertAt = 0;
let openTrade: Intra30Row | null = null;

function log(...args: unknown[]) {
  console.log(`[intra30 ${new Date().toLocaleTimeString()}]`, ...args);
}

function resolveBar(row: Intra30Row, bar: Candle): "TP1_HIT" | "SL_HIT" | null {
  const buy = row.direction === "BUY";
  const hitSl = buy ? bar.low <= row.sl : bar.high >= row.sl;
  const hitTp = buy ? bar.high >= row.tp1 : bar.low <= row.tp1;
  if (hitSl && hitTp) return "SL_HIT";
  if (hitSl) return "SL_HIT";
  if (hitTp) return "TP1_HIT";
  return null;
}

async function tick(): Promise<void> {
  const frames = await fetchMultiTimeframe(ASSET, "intraday", undefined, {
    rebaseToLive: true,
  });

  if (!frames.primary?.length || !frames.daily?.length) {
    log("no candles");
    return;
  }

  const db = getLiveIntra30Db();
  const last = frames.primary[frames.primary.length - 1];
  const d = ASSETS[ASSET].decimals;

  if (!openTrade) {
    const resumed = getOpenOrLatestIntra30(db);
    if (resumed?.outcome === "OPEN") {
      openTrade = resumed;
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
        entryTolerance(ASSETS[ASSET], "intraday", last.close),
      );
      if (state === "MISSED") {
        updateIntra30Outcome(db, openTrade.id, "INVALIDATED", 0, Date.now());
        log("invalidated unexecuted stale lock", openTrade.direction, openTrade.entry);
        openTrade = null;
      } else if (state === "EXECUTED") {
        const at = Date.now();
        markIntra30Executed(db, openTrade.id, at);
        openTrade = { ...openTrade, executedAt: at };
        log("EXECUTED", openTrade.direction, "@", openTrade.entry);
      }
    }
    if (openTrade?.executedAt) {
      const hit = resolveBar(openTrade, last);
      if (hit) {
        updateIntra30Outcome(
          db,
          openTrade.id,
          hit,
          intra30RealizedR(hit),
          Date.now(),
        );
        log("resolved", openTrade.direction, hit);
        openTrade = null;
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
  if (
    !isFreshPendingEntryViable(
      sig.direction,
      sig.entry,
      sig.sl,
      sig.tp1,
      last,
      entryTolerance(ASSETS[ASSET], "intraday", last.close),
    )
  ) {
    return;
  }

  const row = signalToRow(sig, ASSET, "live");
  insertIntra30Row(db, row);
  openTrade = row;
  lastAlertAt = Date.now();

  const body = [
    `${sig.direction} @ ${sig.entry.toFixed(d)}`,
    `SL ${sig.sl.toFixed(d)} (−$6) · TP ${sig.tp1.toFixed(d)} (+$3)`,
    `Conf ${sig.confidence}% · Regime ${sig.regime} · Daily ${sig.dailyBias}`,
    ...sig.reason.slice(0, 4),
  ].join("\n");

  log("SIGNAL >>>", sig.direction, sig.entry, `conf=${sig.confidence}`);
  await dispatchTradeAlert({
    kind: "PLAN_LOCK",
    assetId: ASSET,
    mode: "intra30",
    side: sig.direction,
    title: "INTRA30 SETUP",
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
  log("started — Intra30 (Intraday copy, TP $3 / SL $6)");
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
  // Default OFF. Never auto-start on Railway — requires explicit opt-in after
  // Step-2 session-lock measurement is approved.
  const flag = (process.env.ENABLE_INTRA30_WORKER ?? "0").toLowerCase();
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
