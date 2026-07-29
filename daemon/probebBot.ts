/**
 * Probeb worker — predict next M5 candle, resolve prior call, track day accuracy.
 *
 * Local:  npm run probeb
 * Auto:   ENABLE_PROBEB_WORKER=1 (or auto on Railway)
 *
 * No demo follow / no trade locks — prediction desk only.
 */
import { fetchMultiTimeframe } from "../src/services/marketData";
import {
  generateProbebPrediction,
  nextCandleSide,
} from "../src/strategies/probebEngine";
import {
  getLiveProbebDb,
  getPendingProbeb,
  insertProbebRow,
  predictionToRow,
  resolveProbeb,
  dayAccuracy,
} from "../src/probeb/store";
import { karachiYmd } from "../src/history/apiHistory";

const TICK_MS = Number(process.env.PROBEB_TICK_MS) || 30_000;
const ASSET = "XAUUSD" as const;

let workerRunning = false;
let lastBarTime: number | null = null;

function log(...args: unknown[]) {
  console.log(`[probeb ${new Date().toLocaleTimeString()}]`, ...args);
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
  const primary = frames.primary;
  const last = primary[primary.length - 1];
  const barTime = last.time;

  // Resolve pending prediction against the candle that just closed.
  const pending = getPendingProbeb(db);
  if (pending && barTime > pending.barTime) {
    // Find index of pending bar, outcome = next candle = last closed if pending was previous
    let pendingIdx = -1;
    for (let i = primary.length - 1; i >= 0; i--) {
      if (primary[i].time === pending.barTime) {
        pendingIdx = i;
        break;
      }
    }
    if (pendingIdx >= 0 && pendingIdx + 1 < primary.length) {
      const actual = nextCandleSide(primary, pendingIdx);
      if (actual) {
        resolveProbeb(db, pending.id, actual);
        const ok = actual === pending.predictedSide;
        log(
          "resolved",
          pending.predictedSide,
          "→",
          actual,
          ok ? "HIT" : "MISS",
          `@${pending.probabilityPct}%`,
        );
        const today = dayAccuracy(db, karachiYmd(Date.now()));
        if (today.resolved > 0) {
          log(
            `today ${today.dayKey}: ${today.correct}/${today.resolved} = ${today.accuracyPct}%` +
              (today.hiResolved
                ? ` · hi-conf ${today.hiCorrect}/${today.hiResolved} = ${today.hiAccuracyPct}%`
                : ""),
          );
        }
      }
    }
  }

  if (lastBarTime === barTime) return;
  lastBarTime = barTime;

  const pred = generateProbebPrediction(frames);
  if (!pred) {
    log("no prediction");
    return;
  }

  const row = predictionToRow(pred, "live");
  insertProbebRow(db, row);
  log(
    "predict next",
    pred.side,
    `${pred.probabilityPct}%`,
    `conf ${pred.confidencePct}%`,
    `n=${pred.sampleN}`,
    pred.bucket,
  );
}

export function startProbebWorker(): void {
  if (workerRunning) {
    log("already running");
    return;
  }
  workerRunning = true;
  log("started — Probeb next-candle probability (no trade locks)");
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
