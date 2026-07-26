/**
 * Weekly learn scheduler — Sunday night PKT (default), every ~7 days.
 *
 *   ENABLE_WEEKLY_LEARN=1   force on
 *   ENABLE_WEEKLY_LEARN=0   force off
 *   ENABLE_WEEKLY_LEARN=auto (default) — ON when Railway / production
 *
 * Heavy 20y backtest is NOT run here — merges live + labeled_20y → retrain.
 */
import {
  daysSinceLastWeeklyRun,
  runWeeklyLearn,
} from "../scripts/learnWeekly";
import { karachiWeekdayHour } from "../src/utils/marketHours";

const CHECK_MS = Number(process.env.WEEKLY_LEARN_CHECK_MS) || 60 * 60 * 1000;
const MIN_DAYS = Number(process.env.LEARN_WEEKLY_MIN_DAYS ?? 6.5);
/** Sunday=0 … run window hour PKT (default 22 = 10pm). */
const RUN_WEEKDAY = Number(process.env.LEARN_WEEKLY_PKT_WEEKDAY ?? 0);
const RUN_HOUR = Number(process.env.LEARN_WEEKLY_PKT_HOUR ?? 22);

let workerRunning = false;
let inFlight = false;

function log(...args: unknown[]) {
  console.log(`[weekly-learn ${new Date().toLocaleTimeString()}]`, ...args);
}

function isRailwayOrProd(): boolean {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.NODE_ENV === "production",
  );
}

export function shouldAutoStartWeeklyLearnWorker(): boolean {
  const flag = String(process.env.ENABLE_WEEKLY_LEARN ?? "auto").toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  return isRailwayOrProd();
}

function inRunWindow(now = Date.now()): boolean {
  const { weekday, hour } = karachiWeekdayHour(now);
  return weekday === RUN_WEEKDAY && hour >= RUN_HOUR;
}

async function maybeRun(): Promise<void> {
  if (inFlight) return;
  const since = daysSinceLastWeeklyRun();
  if (since != null && since < MIN_DAYS) {
    return;
  }
  const overdue = since != null && since >= MIN_DAYS + 1.5;
  if (!inRunWindow() && !overdue) {
    // Wait for Sunday window (unless overdue catch-up)
    return;
  }

  inFlight = true;
  log(
    `starting weekly job (daysSince=${since ?? "never"} overdue=${overdue})…`,
  );
  try {
    const result = await runWeeklyLearn({ log });
    if (result.ok) {
      log("success", `n=${result.sampleN} WR=${result.wr}% live+${result.liveAdded}`);
    } else {
      log("skipped/fail:", result.reason);
    }
  } catch (e) {
    log("fatal:", e instanceof Error ? e.message : e);
  } finally {
    inFlight = false;
  }
}

export function startWeeklyLearnWorker(): void {
  void import("../src/learn/modelStore")
    .then(({ ensureLearnSeeded }) => ensureLearnSeeded())
    .catch(() => undefined);

  if (workerRunning) {
    log("already running");
    return;
  }
  workerRunning = true;
  log(
    `started — check every ${Math.round(CHECK_MS / 60000)}m · Sun≥${RUN_HOUR}:00 PKT · min ${MIN_DAYS}d`,
  );
  void maybeRun();
  setInterval(() => {
    void maybeRun();
  }, CHECK_MS);
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1]?.replace(/\\/g, "/").endsWith("weeklyLearnBot.ts");
if (isDirect) {
  startWeeklyLearnWorker();
}
