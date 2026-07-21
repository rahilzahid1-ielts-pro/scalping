/**
 * Pro alert bot — isolated from daemon/alertBot.ts plan locks.
 * Polls intraday multi-TF, generateProSignal, logs to pro_signals, alerts "[Pro]".
 *
 * Local:  npm run pro
 * Auto:   ENABLE_PRO_WORKER=1 (or auto on Railway)
 */
import { ASSETS } from "../src/config/assets";
import { fetchMultiTimeframe } from "../src/services/marketData";
import { generateProSignal } from "../src/strategies/proEngine";
import { dispatchTradeAlert } from "../src/services/notify";
import {
  getLiveProDb,
  getOpenOrLatestPro,
  insertProRow,
  markProExecuted,
  signalToRow,
  updateProOutcome,
  type ProRow,
} from "../src/pro/store";
import type { Candle } from "../src/types";
import { pendingEntryState } from "../src/history/entryTouch";
import { entryTolerance } from "../src/utils/tradeSafety";

const TICK_MS = Number(process.env.PRO_TICK_MS) || 60_000;
const ASSET = "XAUUSD" as const;
const COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3h between live Pro alerts

let workerRunning = false;
let lastAlertAt = 0;
let openTrade: ProRow | null = null;

function log(...args: unknown[]) {
  console.log(`[pro ${new Date().toLocaleTimeString()}]`, ...args);
}

function resolveBar(row: ProRow, bar: Candle): "TP1_HIT" | "SL_HIT" | null {
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

  const db = getLiveProDb();
  const last = frames.primary[frames.primary.length - 1];
  const d = ASSETS[ASSET].decimals;

  if (!openTrade) {
    const resumed = getOpenOrLatestPro(db);
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
        updateProOutcome(db, openTrade.id, "INVALIDATED", 0, Date.now());
        log("invalidated unexecuted stale lock", openTrade.direction, openTrade.entry);
        openTrade = null;
      } else if (state === "EXECUTED") {
        const at = Date.now();
        markProExecuted(db, openTrade.id, at);
        openTrade = { ...openTrade, executedAt: at };
        log("EXECUTED", openTrade.direction, "@", openTrade.entry);
      }
    }
    if (openTrade?.executedAt) {
      const hit = resolveBar(openTrade, last);
      if (hit) {
        const r = hit === "TP1_HIT" ? 1 : -1;
        updateProOutcome(db, openTrade.id, hit, r, Date.now());
        log("resolved", openTrade.direction, hit);
        openTrade = null;
      }
    }
  }

  if (openTrade) return;
  if (Date.now() - lastAlertAt < COOLDOWN_MS) return;

  let sig;
  try {
    sig = generateProSignal(ASSET, frames, "intraday");
  } catch (e) {
    log("engine:", e instanceof Error ? e.message : e);
    return;
  }
  if (!sig) return;

  const row = signalToRow(sig, ASSET, "live");
  insertProRow(db, row);
  openTrade = row;
  lastAlertAt = Date.now();

  const body = [
    `${sig.direction} @ ${sig.entry.toFixed(d)}`,
    `SL ${sig.sl.toFixed(d)} · TP1 ${sig.tp1.toFixed(d)} · TP2 ${sig.tp2.toFixed(d)}`,
    `Conf ${sig.confidence}% · Regime ${sig.regime} · Daily ${sig.dailyBias}`,
    ...sig.reason.slice(0, 4),
  ].join("\n");

  log("SIGNAL >>>", sig.direction, sig.entry, `conf=${sig.confidence}`);
  await dispatchTradeAlert({
    kind: "PLAN_LOCK",
    assetId: ASSET,
    mode: "pro",
    side: sig.direction,
    title: "PRO SETUP",
    body,
    tagPrefix: "[Pro]",
  });
}

export function startProWorker(): void {
  if (workerRunning) {
    log("already running");
    return;
  }
  workerRunning = true;
  log("started — Gold Pro (strict SMC), isolated from main alertBot");
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

export function shouldAutoStartProWorker(): boolean {
  const flag = (process.env.ENABLE_PRO_WORKER ?? "auto").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  return Boolean(process.env.RAILWAY_ENVIRONMENT);
}

async function main() {
  startProWorker();
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("proBot.ts");
if (isDirect) {
  void main();
}
