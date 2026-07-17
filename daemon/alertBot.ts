/**
 * Background Alert Bot — browser band ho to bhi chalega.
 * Usage: npm run alerts
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { ASSETS } from "../src/config/assets";
import { fetchLiveQuote } from "../src/services/liveQuotes";
import { fetchMultiTimeframe } from "../src/services/marketData";
import { generateSignal } from "../src/strategies/signalEngine";
import { computeNowAction } from "../src/utils/nowAction";
import { roundPrice } from "../src/strategies/indicators";
import {
  loadDaemonState,
  saveDaemonState,
  planKey,
  type DaemonState,
} from "./planStore";
import { createFrozenPlan, shouldKeepFrozenPlan } from "../src/services/tradePlan";
import { logSignalFromLive } from "../src/calibration";
import { resolveOpenSignalsForSymbol } from "../src/calibration/resolveOutcomes";
import { makePlanKey } from "../src/calibration/signalStore";
import { invalidateLoggedPlan } from "../src/calibration/resolveOutcomes";

const execAsync = promisify(exec);
const TICK_MS = 2500;
const SIGNAL_EVERY_N = 8;

let tickCount = 0;

function log(...args: unknown[]) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

async function windowsAlert(title: string, body: string) {
  const safeTitle = title.replace(/"/g, "'");
  const safeBody = body.replace(/"/g, "'").slice(0, 220);
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Warning
$n.Visible = $true
$n.BalloonTipTitle = "${safeTitle}"
$n.BalloonTipText = "${safeBody}"
$n.ShowBalloonTip(15000)
1..6 | ForEach-Object { [console]::beep(1000 + $_ * 80, 280); Start-Sleep -Milliseconds 90 }
Start-Sleep -Seconds 10
$n.Dispose()
`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    await execAsync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
      windowsHide: true,
      timeout: 25000,
    });
  } catch {
    try {
      await execAsync(
        `powershell -NoProfile -Command "1..5 | % { [console]::beep(1100,300); Start-Sleep -m 100 }"`,
      );
    } catch {
      process.stdout.write("\x07\x07\x07\x07");
    }
  }
}

function lockPlan(state: DaemonState, assetId: AssetId, mode: TradeMode, signal: ReturnType<typeof generateSignal>, live: number) {
  const key = planKey(assetId, mode);
  let current = state.plans[key] ?? null;

  // Drop zombie plans: SELL entry far above with price never reaching, stuck TOO_LATE style
  if (current && current.status !== "INVALIDATED") {
    const entry = current.levels.entry;
    const sl = current.levels.stopLoss;
    const risk = Math.abs(sl - entry);
    if (current.side === "SELL" && live > entry + risk * 0.5) {
      current = {
        ...current,
        status: "INVALIDATED",
        note: "Missed entry / ran into SL zone — refreshing plan",
      };
      state.plans[key] = current;
    } else if (current.side === "BUY" && live < entry - risk * 0.5) {
      current = {
        ...current,
        status: "INVALIDATED",
        note: "Missed entry / ran into SL zone — refreshing plan",
      };
      state.plans[key] = current;
    }
  }

  if (current && current.status !== "INVALIDATED" && current.assetId === assetId && current.mode === mode) {
    state.plans[key] = shouldKeepFrozenPlan(current, signal.side, live);
    return state.plans[key];
  }

  if (signal.side !== "WAIT" && signal.levels && signal.confidence >= state.minConfidence) {
    const created = createFrozenPlan(assetId, mode, signal.side, signal.levels);
    state.plans[key] = created.status === "INVALIDATED" ? null : created;
    return state.plans[key];
  }

  // Clear invalidated so next good signal can lock fresh
  if (current?.status === "INVALIDATED") {
    state.plans[key] = null;
  }

  return state.plans[key] ?? null;
}

async function checkOne(state: DaemonState, assetId: AssetId, mode: TradeMode) {
  const asset = ASSETS[assetId];
  const quote = await fetchLiveQuote(assetId);
  const live = quote.price;
  const frames = await fetchMultiTimeframe(assetId, mode, live);
  const signal = generateSignal(assetId, mode, frames);
  signal.price = roundPrice(live, asset.decimals);

  let plan = lockPlan(state, assetId, mode, signal, live);
  if (plan && plan.status !== "INVALIDATED") {
    signal.side = plan.side;
    signal.levels = plan.levels;
  }

  let now = computeNowAction(signal, plan, live, asset, quote);

  // Recycle dead/missed plans — next ticks can lock a fresh WAIT_ENTRY
  if (now.action === "TOO_LATE" || now.action === "PLAN_DEAD") {
    if (plan?.levels && (plan.side === "BUY" || plan.side === "SELL")) {
      invalidateLoggedPlan(
        makePlanKey(
          assetId,
          mode,
          plan.side,
          plan.levels.entry,
          plan.levels.stopLoss,
          plan.levels.takeProfit1,
        ),
        now.action,
      );
    }
    state.plans[planKey(assetId, mode)] = null;
    plan = null;
    // Don't force old side/levels onto signal after clear
    const fresh = generateSignal(assetId, mode, frames);
    fresh.price = roundPrice(live, asset.decimals);
    if (fresh.side !== "WAIT" && fresh.levels && fresh.confidence >= state.minConfidence) {
      plan = createFrozenPlan(assetId, mode, fresh.side, fresh.levels);
      if (plan.status === "INVALIDATED") plan = null;
      state.plans[planKey(assetId, mode)] = plan;
    }
    now = computeNowAction(fresh, plan, live, asset, quote);
    return { signal: fresh, plan, now, quote };
  }

  return { signal, plan, now, quote };
}

async function tick(state: DaemonState) {
  tickCount += 1;
  const verbose = tickCount % SIGNAL_EVERY_N === 1;

  for (const w of state.watches) {
    try {
      const { signal, plan, now, quote } = await checkOne(state, w.assetId, w.mode);
      const label = `${w.assetId}/${w.mode}`;
      const entry = plan?.levels.entry;
      const d = ASSETS[w.assetId].decimals;

      // Persist BUY/SELL emissions (deduped) + resolve open outcomes on live tick
      if (signal.side !== "WAIT" && signal.levels) {
        const toLog =
          plan && plan.status !== "INVALIDATED"
            ? {
                ...signal,
                side: plan.side,
                levels: plan.levels,
              }
            : signal;
        logSignalFromLive(toLog);
      }
      resolveOpenSignalsForSymbol(w.assetId, {
        price: quote.price,
        high: quote.high,
        low: quote.low,
        open: quote.price,
      });

      if (verbose || now.action === "ENTER_NOW" || now.action === "TOO_LATE" || now.action === "WAIT_ENTRY") {
        log(
          `${label.padEnd(16)} ${now.action.padEnd(12)} live=${quote.price.toFixed(d)} entry=${entry ?? "-"} conf=${signal.confidence}% win=${signal.rangePrediction.winProbability}%`,
        );
      }

      const highQuality =
        now.action === "ENTER_NOW" &&
        now.inEntryZone &&
        now.entry != null &&
        signal.confidence >= state.minConfidence &&
        signal.rangePrediction.winProbability >= state.minWinProb &&
        // Price must be near locked entry (not a fake far signal)
        Math.abs(quote.price - now.entry) <= Math.abs(now.stopLoss! - now.entry) * 0.35;

      if (highQuality) {
        const alertKey = `${label}:${now.side}:${now.entry}`;
        const last = state.lastAlertAt[alertKey] ?? 0;
        if (Date.now() - last > 5 * 60 * 1000) {
          state.lastAlertAt[alertKey] = Date.now();
          const title = `${now.headlineUr} | ${ASSETS[w.assetId].name}`;
          const body = `${now.side} @ ${now.entry} | Live ${now.livePrice} | SL ${now.stopLoss} TP ${now.takeProfit} | Conf ${signal.confidence}% Win ${signal.rangePrediction.winProbability}% (${w.mode})`;
          log("ALERT >>>", title);
          await windowsAlert(title, body);
        }
      }
    } catch (e) {
      log(`ERR ${w.assetId}/${w.mode}:`, e instanceof Error ? e.message : e);
    }
  }

  saveDaemonState(state);
}

async function main() {
  const state = loadDaemonState();
  saveDaemonState(state);

  console.log(`
════════════════════════════════════════════════
  SMC BACKGROUND ALERT BOT
  Tab band / minimize — alerts phir bhi aayenge
════════════════════════════════════════════════
  Pairs : ${state.watches.map((w) => `${w.assetId}/${w.mode}`).join(", ")}
  Gate  : conf>=${state.minConfidence}%  win>=${state.minWinProb}%
  Poll  : every ${TICK_MS}ms
  Stop  : Ctrl+C
════════════════════════════════════════════════
`);

  try {
    await execAsync(`powershell -NoProfile -Command "[console]::beep(900,250)"`);
    log("Ready — high-probability ENTRY pe Windows toast + beeps");
  } catch {
    log("Ready (beep test skipped)");
  }

  for (;;) {
    await tick(state);
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
