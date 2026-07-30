/**
 * Probeb worker — one call per closed M5 slot, HTF-gated, resolve SAHI/GALAT.
 */
import { fetchMultiTimeframe } from "../src/services/marketData";
import {
  closedM5Bars,
  diagnoseProbeb,
  m5FloorMs,
  nextCandleSide,
} from "../src/strategies/probebEngine";
import {
  getLiveProbebDb,
  getLatestProbeb,
  insertProbebRow,
  listPendingProbeb,
  predictionToRow,
  purgeUnstablePending,
  resolveProbeb,
  dayAccuracy,
} from "../src/probeb/store";
import { karachiYmd } from "../src/history/apiHistory";
import { dispatchTradeAlert } from "../src/services/notify";

const TICK_MS = Number(process.env.PROBEB_TICK_MS) || 20_000;
const ASSET = "XAUUSD" as const;
const ALERT_PROB_MIN = Number(process.env.PROBEB_ALERT_PROB_MIN) || 60;
const ALERT_CONF_MIN = Number(process.env.PROBEB_ALERT_CONF_MIN) || 40;

let workerRunning = false;
let lastPredictedBar: number | null = null;
let lastAlertBar: number | null = null;

function log(...args: unknown[]) {
  console.log(`[probeb ${new Date().toLocaleTimeString()}]`, ...args);
}

function resolvePending(
  db: ReturnType<typeof getLiveProbebDb>,
  primary: { time: number; open: number; high: number; low: number; close: number; volume: number }[],
): void {
  const closed = closedM5Bars(primary);
  for (const pending of listPendingProbeb(db)) {
    const want = m5FloorMs(pending.barTime);
    let idx = -1;
    for (let i = 0; i < closed.length; i++) {
      if (closed[i].time === want) {
        idx = i;
        break;
      }
    }
    if (idx < 0 || idx + 1 >= closed.length) continue;
    const actual = nextCandleSide(closed, idx);
    if (!actual) continue;
    resolveProbeb(db, pending.id, actual);
    const ok = actual === pending.predictedSide;
    log(
      ok ? "SAHI" : "GALAT",
      pending.predictedSide,
      "→",
      actual,
      `win ${pending.probabilityPct}% conf ${pending.confidencePct}%`,
    );
  }
  const today = dayAccuracy(db, karachiYmd(Date.now()));
  if (today.resolved > 0) {
    log(
      `aaj ${today.dayKey}: sahi ${today.correct} · galat ${today.wrong} · ${today.accuracyPct}%`,
    );
  }
}

async function maybeAlertStrong(pred: {
  side: "BUY" | "SELL";
  probabilityPct: number;
  confidencePct: number;
  barTime: number;
}): Promise<void> {
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
  const frames = await fetchMultiTimeframe(ASSET, "scalping", undefined, {
    rebaseToLive: true,
  });
  if (!frames.primary || frames.primary.length < 100) {
    log("no candles");
    return;
  }

  const db = getLiveProbebDb();
  resolvePending(db, frames.primary);

  const diag = diagnoseProbeb(frames);
  if (!diag.signal) {
    if (diag.waitReason) log("wait:", diag.waitReason);
    return;
  }
  const pred = diag.signal;

  if (lastPredictedBar === pred.barTime) return;
  const latest = getLatestProbeb(db);
  if (latest && m5FloorMs(latest.barTime) === pred.barTime) {
    lastPredictedBar = pred.barTime;
    return;
  }

  lastPredictedBar = pred.barTime;

  insertProbebRow(db, predictionToRow(pred, "live"));
  log(
    "predict agli candle",
    pred.side,
    `target=${new Date(pred.targetBarTime).toISOString().slice(11, 16)}Z`,
    `win ${pred.probabilityPct}%`,
    `conf ${pred.confidencePct}%`,
    pred.quality,
  );
  if (pred.quality === "strong") await maybeAlertStrong(pred);
}

export function startProbebWorker(): void {
  if (workerRunning) {
    log("already running");
    return;
  }
  workerRunning = true;
  log(
    `started — Probeb every closed M5 · strong alert ≥${ALERT_PROB_MIN}% + conf ≥${ALERT_CONF_MIN}%`,
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
  return Boolean(process.env.RAILWAY_ENVIRONMENT);
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
