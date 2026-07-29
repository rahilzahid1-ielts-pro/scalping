/**
 * Probeb worker — one prediction per closed M5, resolve SAHI/GALAT, strong-conf alert.
 *
 * Local:  npm run probeb
 * Auto:   ENABLE_PROBEB_WORKER=1 (or auto on Railway)
 */
import { fetchMultiTimeframe } from "../src/services/marketData";
import {
  generateProbebPrediction,
  m5FloorMs,
  nextCandleSide,
} from "../src/strategies/probebEngine";
import {
  getLiveProbebDb,
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
/** Strong call: win-prob + confidence both clear the bar. */
const ALERT_PROB_MIN = Number(process.env.PROBEB_ALERT_PROB_MIN) || 60;
const ALERT_CONF_MIN = Number(process.env.PROBEB_ALERT_CONF_MIN) || 40;

let workerRunning = false;
let lastPredictedBar: number | null = null;
let lastAlertBar: number | null = null;

function log(...args: unknown[]) {
  console.log(`[probeb ${new Date().toLocaleTimeString()}]`, ...args);
}

function findBarIndex(
  primary: { time: number }[],
  barTime: number,
): number {
  const want = m5FloorMs(barTime);
  for (let i = primary.length - 1; i >= 0; i--) {
    if (m5FloorMs(primary[i].time) === want) return i;
  }
  return -1;
}

function resolvePending(
  db: ReturnType<typeof getLiveProbebDb>,
  primary: Parameters<typeof nextCandleSide>[0],
): void {
  // Forming bar = last; need next candle after pending to be fully closed
  // → pendingIdx + 1 < primary.length - 1, OR pendingIdx + 1 === length - 2
  const formingIdx = primary.length - 1;
  for (const pending of listPendingProbeb(db)) {
    const idx = findBarIndex(primary, pending.barTime);
    if (idx < 0) continue;
    const nextIdx = idx + 1;
    // Next bar must exist and not be the still-forming tip (or tip already
    // past — if nextIdx < formingIdx then next is closed).
    if (nextIdx >= formingIdx) continue;
    const actual = nextCandleSide(primary, idx);
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
    `Strong Probeb call — chart pe confirm karke dekho.`,
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

  const pred = generateProbebPrediction(frames);
  if (!pred) {
    log("no prediction");
    return;
  }

  if (lastPredictedBar === pred.barTime) return;
  lastPredictedBar = pred.barTime;

  const row = predictionToRow(pred, "live");
  insertProbebRow(db, row);
  log(
    "predict next M5",
    pred.side,
    `win ${pred.probabilityPct}%`,
    `conf ${pred.confidencePct}%`,
    `n=${pred.sampleN}`,
  );
  await maybeAlertStrong(pred);
}

export function startProbebWorker(): void {
  if (workerRunning) {
    log("already running");
    return;
  }
  workerRunning = true;
  log(
    `started — Probeb M5 SAHI/GALAT · strong alert ≥${ALERT_PROB_MIN}% win + ≥${ALERT_CONF_MIN}% conf`,
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
