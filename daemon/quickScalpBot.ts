/**
 * Quick Scalp BLITZ bot — isolated from alertBot plan locks.
 * Polls scalping multi-TF, generateQuickScalpSignal (SMC+trend gates+fast TP1).
 */
import { ASSETS } from "../src/config/assets";
import { fetchMultiTimeframe } from "../src/services/marketData";
import { generateQuickScalpSignal } from "../src/strategies/quickScalpEngine";
import { dispatchTradeAlert } from "../src/services/notify";
import {
  getLiveQuickScalpDb,
  getOpenOrLatestQuickScalp,
  insertQuickScalpRow,
  markQuickScalpExecuted,
  signalToRow,
  updateQuickScalpOutcome,
  type QuickScalpRow,
} from "../src/quickScalp/store";
import type { Candle } from "../src/types";
import { barTouchedEntryLevel } from "../src/history/entryTouch";

const TICK_MS = Number(process.env.QUICK_SCALP_TICK_MS) || 15_000;
const ASSET = "XAUUSD" as const;
const COOLDOWN_MS = 45 * 60 * 1000; // 45m between blitz alerts

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

  if (!frames.primary?.length || !frames.daily?.length) {
    log("no candles");
    return;
  }

  const db = getLiveQuickScalpDb();
  const last = frames.primary[frames.primary.length - 1];
  const d = ASSETS[ASSET].decimals;

  // After redeploy, resume OPEN from SQLite so lock does not vanish / double-fire.
  if (!openTrade) {
    const resumed = getOpenOrLatestQuickScalp(db);
    if (resumed?.outcome === "OPEN") {
      openTrade = resumed;
      log("resumed OPEN", openTrade.direction, openTrade.entry);
    }
  }

  if (openTrade) {
    if (!openTrade.executedAt && barTouchedEntryLevel(openTrade.entry, last)) {
      const at = Date.now();
      markQuickScalpExecuted(db, openTrade.id, at);
      openTrade = { ...openTrade, executedAt: at };
      log("EXECUTED", openTrade.direction, "@", openTrade.entry);
    }
    if (openTrade.executedAt) {
      const hit = resolveBar(openTrade, last);
      if (hit) {
        const risk = Math.abs(openTrade.entry - openTrade.sl);
        const tp1R = risk > 0 ? Math.abs(openTrade.tp1 - openTrade.entry) / risk : 0.85;
        const r = hit === "TP1_HIT" ? tp1R : -1;
        updateQuickScalpOutcome(db, openTrade.id, hit, r, Date.now());
        log("resolved", openTrade.direction, hit);
        openTrade = null;
      }
    }
  }

  if (openTrade) return;
  if (Date.now() - lastAlertAt < COOLDOWN_MS) return;

  let sig;
  try {
    sig = generateQuickScalpSignal(frames, ASSET, "scalping");
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
    `${sig.direction} BLITZ @ ${sig.entry.toFixed(d)}`,
    `SL ${sig.sl.toFixed(d)} · TP1 FAST ${sig.tp1.toFixed(d)} · TP2 ${sig.tp2.toFixed(d)}`,
    `Conf ${sig.confidence}% · ${sig.regime} · Daily ${sig.dailyTrend}`,
    `Exit at TP1 — size up only on small risk distance`,
    ...sig.reason.slice(0, 3),
  ].join("\n");

  log("SIGNAL >>>", sig.direction, sig.entry, `conf=${sig.confidence}`);
  await dispatchTradeAlert({
    kind: "PLAN_LOCK",
    assetId: ASSET,
    mode: "quick_scalp",
    side: sig.direction,
    title: "BLITZ SETUP",
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
  log("started — Gold BLITZ (SMC trend + fast TP1), isolated from main alertBot");
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
  return Boolean(process.env.RAILWAY_ENVIRONMENT);
}

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
