/**
 * Probeb worker — every tick: live-M5 ingest + resolve + one predict / slot.
 * STRONG → demo auto ±$2 + alert.
 */
import { syncProbebLive } from "../src/probeb/syncLive";
import {
  getLiveProbebDb,
  purgeUnstablePending,
  dayAccuracy,
} from "../src/probeb/store";
import { PROBEB_AUTO_DISTANCE } from "../src/probeb/autoTrade";
import { karachiYmd } from "../src/history/apiHistory";
import { dispatchTradeAlert } from "../src/services/notify";

const TICK_MS = Number(process.env.PROBEB_TICK_MS) || 10_000;
const ASSET = "XAUUSD" as const;
const ALERT_PROB_MIN = Number(process.env.PROBEB_ALERT_PROB_MIN) || 60;
const ALERT_CONF_MIN = Number(process.env.PROBEB_ALERT_CONF_MIN) || 40;

let workerRunning = false;
let lastAlertBar: number | null = null;

function log(...args: unknown[]) {
  console.log(`[probeb ${new Date().toLocaleTimeString()}]`, ...args);
}

async function maybeAlertStrong(pred: {
  side: "BUY" | "SELL";
  probabilityPct: number;
  confidencePct: number;
  barTime: number;
  quality?: string;
  entry?: number;
  sl?: number;
  tp1?: number;
  autoOpened?: boolean;
}): Promise<void> {
  if (pred.quality && pred.quality !== "strong") return;
  if (pred.probabilityPct < ALERT_PROB_MIN) return;
  if (pred.confidencePct < ALERT_CONF_MIN) return;
  if (lastAlertBar === pred.barTime) return;
  lastAlertBar = pred.barTime;
  const levels =
    pred.entry != null && pred.sl != null && pred.tp1 != null
      ? `\nEntry ${pred.entry} · SL ${pred.sl} · TP ${pred.tp1} (±$${PROBEB_AUTO_DISTANCE})`
      : `\nLevels ±$${PROBEB_AUTO_DISTANCE} from live`;
  const body = [
    `Agli M5 candle: ${pred.side}`,
    `Winning probability ${pred.probabilityPct.toFixed(1)}%`,
    `Confidence ${pred.confidencePct}%`,
    pred.autoOpened
      ? `Demo AUTO OPENED${levels}`
      : `STRONG — demo auto ±$${PROBEB_AUTO_DISTANCE} (agar auto-follow ON)`,
    `HTF+edge cleared.`,
  ].join("\n");
  log(
    "STRONG ALERT",
    pred.side,
    `${pred.probabilityPct}%`,
    `conf ${pred.confidencePct}%`,
    pred.autoOpened ? "DEMO OPEN" : "",
  );
  await dispatchTradeAlert({
    kind: "PLAN_LOCK",
    assetId: ASSET,
    mode: "probeb",
    side: pred.side,
    title: pred.autoOpened
      ? "PROBEB STRONG — DEMO ±$2 OPEN"
      : "PROBEB STRONG — NEXT CANDLE",
    body,
    tagPrefix: "[Probeb]",
  });
}

async function tick(): Promise<void> {
  const synced = await syncProbebLive();
  if (synced.resolved > 0) {
    log("resolved", synced.resolved);
    const today = dayAccuracy(getLiveProbebDb(), karachiYmd(Date.now()));
    if (today.resolved > 0) {
      log(
        `aaj ${today.dayKey}: sahi ${today.correct} · galat ${today.wrong} · ${today.accuracyPct}%`,
      );
    }
  }
  if (synced.autoTrade?.ok) {
    log(
      "DEMO AUTO",
      synced.signal?.side,
      `@${synced.autoTrade.entry}`,
      `SL ${synced.autoTrade.sl}`,
      `TP ${synced.autoTrade.tp1}`,
    );
  } else if (synced.autoTrade && !synced.autoTrade.ok) {
    if (
      synced.signal?.quality === "strong" &&
      !/already opened|not STRONG/i.test(synced.autoTrade.reason)
    ) {
      log("auto skip:", synced.autoTrade.reason);
    }
  }
  if (synced.inserted) {
    const pred = synced.inserted;
    log(
      "predict agli candle",
      pred.side,
      `target=${new Date(pred.targetBarTime).toISOString().slice(11, 16)}Z`,
      `win ${pred.probabilityPct}%`,
      `conf ${pred.confidencePct}%`,
      pred.quality,
    );
    await maybeAlertStrong({
      ...pred,
      entry: synced.autoTrade?.ok ? synced.autoTrade.entry : undefined,
      sl: synced.autoTrade?.ok ? synced.autoTrade.sl : undefined,
      tp1: synced.autoTrade?.ok ? synced.autoTrade.tp1 : undefined,
      autoOpened: Boolean(synced.autoTrade?.ok),
    });
  } else if (
    synced.autoTrade?.ok &&
    synced.signal &&
    lastAlertBar !== synced.signal.barTime
  ) {
    await maybeAlertStrong({
      ...synced.signal,
      entry: synced.autoTrade.entry,
      sl: synced.autoTrade.sl,
      tp1: synced.autoTrade.tp1,
      autoOpened: true,
    });
  } else if (!synced.signal && synced.waitReason) {
    log("wait:", synced.waitReason);
  }
}

export function startProbebWorker(): void {
  if (workerRunning) {
    log("already running");
    return;
  }
  workerRunning = true;
  log(
    `started — live M5 · STRONG auto demo ±$${PROBEB_AUTO_DISTANCE} · alert ≥${ALERT_PROB_MIN}% + conf ≥${ALERT_CONF_MIN}%`,
  );
  try {
    const n = purgeUnstablePending(getLiveProbebDb());
    if (n > 0) log("purged unstable rows:", n);
  } catch (e) {
    log("purge skip:", e instanceof Error ? e.message : e);
  }
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

export function shouldAutoStartProbebWorker(): boolean {
  const flag = (process.env.ENABLE_PROBEB_WORKER ?? "auto").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  return true;
}

async function main() {
  startProbebWorker();
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("probebBot.ts");

if (isDirect) {
  void main();
}
