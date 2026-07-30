/**
 * Probeb worker — live M5 sync + STRONG auto ±$2 (1 SL/day pause).
 */
import { syncProbebLive } from "../src/probeb/syncLive";
import {
  getLiveProbebDb,
  purgeUnstablePending,
  dayAccuracy,
} from "../src/probeb/store";
import {
  isProbebAutoTradeSetup,
  PROBEB_AUTO_DISTANCE,
  PROBEB_AUTO_MAX_SL_TODAY,
  PROBEB_AUTO_WIN_MIN,
} from "../src/probeb/autoTrade";
import { karachiYmd } from "../src/history/apiHistory";
import { dispatchTradeAlert } from "../src/services/notify";

const TICK_MS = Number(process.env.PROBEB_TICK_MS) || 10_000;
const ASSET = "XAUUSD" as const;

let workerRunning = false;
let lastAlertBar: number | null = null;

function log(...args: unknown[]) {
  console.log(`[probeb ${new Date().toLocaleTimeString()}]`, ...args);
}

async function maybeAlertAuto(pred: {
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
  // Alert only when we actually opened, or when full STRONG gate clears.
  if (!pred.autoOpened && !isProbebAutoTradeSetup(pred as Parameters<typeof isProbebAutoTradeSetup>[0])) {
    return;
  }
  if (lastAlertBar === pred.barTime) return;
  lastAlertBar = pred.barTime;
  const levels =
    pred.entry != null && pred.sl != null && pred.tp1 != null
      ? `\nEntry ${pred.entry} · SL ${pred.sl} · TP ${pred.tp1} (±$${PROBEB_AUTO_DISTANCE})`
      : `\nLevels ±$${PROBEB_AUTO_DISTANCE} from live`;
  const body = [
    `Agli M5 candle: ${pred.side}`,
    `Winning ${pred.probabilityPct.toFixed(1)}% · conf ${pred.confidencePct}% · ${pred.quality ?? ""}`,
    pred.autoOpened
      ? `Demo AUTO OPENED${levels}`
      : `STRONG setup — demo ±$${PROBEB_AUTO_DISTANCE} (1 SL/day pause)`,
  ].join("\n");
  log(
    "AUTO ALERT",
    pred.side,
    `${pred.probabilityPct}%`,
    pred.autoOpened ? "DEMO OPEN" : "STRONG",
  );
  await dispatchTradeAlert({
    kind: "PLAN_LOCK",
    assetId: ASSET,
    mode: "probeb",
    side: pred.side,
    title: pred.autoOpened
      ? "PROBEB STRONG — DEMO ±$2 OPEN"
      : "PROBEB STRONG SETUP",
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
      synced.signal &&
      isProbebAutoTradeSetup(synced.signal) &&
      !/already opened/i.test(synced.autoTrade.reason)
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
    await maybeAlertAuto({
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
    await maybeAlertAuto({
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
    `started — STRONG+win>${PROBEB_AUTO_WIN_MIN} → demo ±$${PROBEB_AUTO_DISTANCE} · pause after ${PROBEB_AUTO_MAX_SL_TODAY} SL/day`,
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
