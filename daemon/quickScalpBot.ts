/**
 * Quick Scalp alert bot — isolated from daemon/alertBot.ts / generateSignal.
 * Polls M5 + Daily, calls generateQuickScalpSignal, logs to quick_scalp_signals,
 * and dispatches alerts tagged "[Quick Scalp]".
 *
 * Local:  npm run quickscalp
 * Auto:   started from prodServer when ENABLE_QUICK_SCALP_WORKER=1 (or auto with alerts)
 */
import { ASSETS } from "../src/config/assets";
import { fetchMultiTimeframe } from "../src/services/marketData";
import { generateQuickScalpSignal } from "../src/strategies/quickScalpEngine";
import { dispatchTradeAlert } from "../src/services/notify";
import {
  getLiveQuickScalpDb,
  insertQuickScalpRow,
  signalToRow,
  updateQuickScalpOutcome,
  type QuickScalpRow,
} from "../src/quickScalp/store";
import type { Candle } from "../src/types";

const TICK_MS = Number(process.env.QUICK_SCALP_TICK_MS) || 15_000;
const ASSET = "XAUUSD" as const;
const COOLDOWN_MS = 60 * 60 * 1000; // 1h between live alerts

let workerRunning = false;
let lastAlertAt = 0;
let openTrade: QuickScalpRow | null = null;

function log(...args: unknown[]) {
  console.log(`[quickScalp ${new Date().toLocaleTimeString()}]`, ...args);
}

function resolveBar(row: QuickScalpRow, bar: Candle): "TP1_HIT" | "SL_HIT" | null {
  const buy = row.direction === "BUY";
  const hitSl = buy ? bar.low <= row.sl : bar.high >= row.sl;
  const hitTp = buy ? bar.high >= row.tp1 : bar.low <= row.tp1;
  if (hitSl && hitTp) return "SL_HIT";
  if (hitSl) return "SL_HIT";
  if (hitTp) return "TP1_HIT";
  return null;
}

async function tick(): Promise<void> {
  const frames = await fetchMultiTimeframe(ASSET, "scalping", undefined, {
    rebaseToLive: false,
  });

  const m5 = frames.primary;
  const daily = frames.daily;
  if (!m5?.length || !daily?.length) {
    log("no candles");
    return;
  }

  const db = getLiveQuickScalpDb();
  const last = m5[m5.length - 1];
  const d = ASSETS[ASSET].decimals;

  // Resolve open trade against latest bar
  if (openTrade) {
    const hit = resolveBar(openTrade, last);
    if (hit) {
      const r = hit === "TP1_HIT" ? 1 : -1;
      updateQuickScalpOutcome(db, openTrade.id, hit, r, Date.now());
      log("resolved", openTrade.direction, hit);
      openTrade = null;
    }
  }

  if (openTrade) return;
  if (Date.now() - lastAlertAt < COOLDOWN_MS) return;

  let sig;
  try {
    sig = generateQuickScalpSignal({ m5Candles: m5, dailyCandles: daily });
  } catch (e) {
    log("engine:", e instanceof Error ? e.message : e);
    return;
  }
  if (!sig) return;

  const row = signalToRow(sig, ASSET, "live");
  insertQuickScalpRow(db, row);
  openTrade = row;
  lastAlertAt = Date.now();

  const body = [
    `${sig.direction} @ ${sig.entry.toFixed(d)}`,
    `SL ${sig.sl.toFixed(d)} · TP1 ${sig.tp1.toFixed(d)} · TP2 ${sig.tp2.toFixed(d)}`,
    `Daily: ${sig.dailyTrend}`,
    ...sig.reason,
  ].join("\n");

  log("SIGNAL >>>", sig.direction, sig.entry);
  await dispatchTradeAlert({
    kind: "PLAN_LOCK",
    assetId: ASSET,
    mode: "quick_scalp",
    side: sig.direction,
    title: "SETUP",
    body,
    tagPrefix: "[Quick Scalp]",
  });
}

export function startQuickScalpWorker(): void {
  if (workerRunning) {
    log("already running");
    return;
  }
  workerRunning = true;
  log("started — Gold M5 + Daily, isolated from main alertBot");
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

export function shouldAutoStartQuickScalpWorker(): boolean {
  const flag = (process.env.ENABLE_QUICK_SCALP_WORKER ?? "auto").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  // auto: follow main alert worker presence on Railway
  return Boolean(process.env.RAILWAY_ENVIRONMENT);
}

/** CLI: npm run quickscalp */
async function main() {
  startQuickScalpWorker();
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("quickScalpBot.ts");
if (isDirect) {
  void main();
}
