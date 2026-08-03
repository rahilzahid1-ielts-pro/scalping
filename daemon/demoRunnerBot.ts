/**
 * Demo runner tick — auto-follow history + resolve exits without UI.
 *
 * Before: syncDemoFromHistory only ran inside `/api/demo/account`, which only
 * mounts on the Demo $ tab. Staying on Probeb/QS Pro meant no module follows.
 * Also the tick early-returned when no OPEN positions, so an empty book never
 * picked up new EXECUTED locks.
 */
import { fetchTradingViewQuoteCached } from "../src/services/liveQuotes";
import {
  resolveOpenAgainstPrice,
  voidProbebQuoteSpikeTrades,
} from "../src/demoAccount/engine";
import { syncDemoFromHistory } from "../src/demoAccount/syncFromHistory";
import { listOpenDemoPositions } from "../src/demoAccount/store";

const TICK_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function shouldAutoStartDemoRunner(): boolean {
  const v = (process.env.ENABLE_DEMO_RUNNER ?? "").toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Always mirror EXECUTED module locks — even when the book is empty.
    const sync = await syncDemoFromHistory();
    if (sync.opened > 0 || sync.closed > 0) {
      console.log(
        `[demoRunner] sync opened=${sync.opened} closed=${sync.closed} skipped=${sync.skipped} dayR=${sync.dayBudget?.netR ?? "?"}`,
      );
    }
    for (const err of sync.errors.slice(0, 3)) {
      console.warn(`[demoRunner] sync err: ${err}`);
    }

    const quote = await fetchTradingViewQuoteCached("XAUUSD");
    const price = quote?.price;
    if (price == null || !Number.isFinite(price)) return;

    try {
      voidProbebQuoteSpikeTrades(price);
    } catch {
      /* optional */
    }

    if (listOpenDemoPositions().length === 0) return;
    const { closed } = resolveOpenAgainstPrice(price);
    for (const p of closed) {
      console.log(
        `[demoRunner] ${p.module} ${p.side} closed ${p.outcome} R=${p.realizedR} P&L $${p.pnlUsd}`,
      );
    }
  } catch (e) {
    console.error("[demoRunner] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startDemoRunnerWorker(): void {
  if (timer) return;
  console.log(
    `[demoRunner] ON — auto-follow + exits every ${TICK_MS / 1000}s (UI not required)`,
  );
  void tick();
  timer = setInterval(() => void tick(), TICK_MS);
}

export function stopDemoRunnerWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

const isDirect =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("demoRunnerBot.ts");
if (isDirect) startDemoRunnerWorker();
