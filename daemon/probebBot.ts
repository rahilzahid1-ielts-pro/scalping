/**
 * Probeb worker — every tick: live-M5 ingest + resolve + one predict / slot.
 */
import { syncProbebLive } from "../src/probeb/syncLive";
import {
  getLiveProbebDb,
  purgeUnstablePending,
  dayAccuracy,
} from "../src/probeb/store";
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
}): Promise<void> {
  if (pred.quality && pred.quality !== "strong") return;
  if (pred.probabilityPct < ALERT_PROB_MIN) return;
  if (pred.confidencePct < ALERT_CONF_MIN) return;
  if (lastAlertBar === pred.barTime) return;
  lastAlertBar = pred.barTime;
  const body = [
    `Agli M5 candle: ${pred.side}`,
    `Winning probability ${pred.probabilityPct.toFixed(1)}%`,
    `Confidence ${pred.confidencePct}%`,
    `Strong Probeb call — HTF+edge cleared.`,
  ].join("\n");
  log("STRONG ALERT", pred.side, `${pred.probabilityPct}%`, `conf ${pred.confidencePct}%`);
  await dispatchTradeAlert({
    kind: "PLAN_LOCK",
    assetId: ASSET,
    mode: "probeb",
    side: pred.side,
    title: "PROBEB STRONG — NEXT CANDLE",
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
    await maybeAlertStrong(pred);
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
    `started — live M5 clock · every closed M5 · strong alert ≥${ALERT_PROB_MIN}% + conf ≥${ALERT_CONF_MIN}%`,
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
  // Default ON in prod / Railway; also ON when not explicitly disabled locally
  // so /api sync + worker both keep the desk live.
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
