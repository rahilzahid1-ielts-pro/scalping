/**
 * Demo runner tick — keeps demo exits moving without a UI request.
 *
 * The trend runner trails its stop behind the best price seen, so it needs the
 * price polled regularly. Before this, `resolveOpenAgainstPrice` only ran when
 * something hit `/api/demo/account`, which means a runner could sit unmanaged
 * for as long as nobody had the app open.
 */
import { fetchTradingViewQuoteCached } from "../src/services/liveQuotes";
import { resolveOpenAgainstPrice } from "../src/demoAccount/engine";
import { listOpenDemoPositions } from "../src/demoAccount/store";

const TICK_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function shouldAutoStartDemoRunner(): boolean {
  const v = (process.env.ENABLE_DEMO_RUNNER ?? "").toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  // On by default: an untended runner is worse than no runner.
  return true;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (listOpenDemoPositions().length === 0) return;
    const quote = await fetchTradingViewQuoteCached("XAUUSD");
    const price = quote?.price;
    if (price == null || !Number.isFinite(price)) return;
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
  console.log(`[demoRunner] ON — resolving demo exits every ${TICK_MS / 1000}s`);
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
