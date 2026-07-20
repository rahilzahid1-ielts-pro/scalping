/**
 * Shared poller factory for compare strategies (cipher_b_clone / ict / fractal).
 * Modeled on daemon/quickScalpBot.ts — does not import or modify that file.
 */
import { ASSETS } from "../config/assets";
import { fetchMultiTimeframe } from "../services/marketData";
import { dispatchTradeAlert } from "../services/notify";
import { generateCipherBSignal } from "../strategies/archived/cipherBSignal";
import { generateIctSignal } from "../strategies/archived/ictSignal";
import { generateFractalSignal } from "../strategies/archived/fractalSignal";
import { candlesAsUnixSeconds, resolveBarOutcome } from "./resolve";
import {
  getLiveStrategyDb,
  insertStrategyRow,
  makeStrategyRow,
  updateStrategyOutcome,
  type CompareStrategy,
  type StrategySignalRow,
} from "./store";
import type { Candle } from "../types";

const ASSET = "XAUUSD" as const;
const COOLDOWN_MS = 60 * 60 * 1000;

export interface CompareBotConfig {
  strategy: CompareStrategy;
  tagPrefix: string;
  modeLabel: string;
  tickMs: number;
  envFlag: string;
}

function emit(strategy: CompareStrategy, m5: Candle[]) {
  if (strategy === "cipher_b_clone") return generateCipherBSignal({ candles: m5 });
  if (strategy === "fractal") return generateFractalSignal({ candles: m5 });
  const sig = generateIctSignal({ candles: candlesAsUnixSeconds(m5) });
  if (!sig) return null;
  return { ...sig, time: m5[m5.length - 1].time };
}

export function createCompareBot(cfg: CompareBotConfig) {
  let workerRunning = false;
  let lastAlertAt = 0;
  let openTrade: StrategySignalRow | null = null;

  function log(...args: unknown[]) {
    console.log(`[${cfg.strategy} ${new Date().toLocaleTimeString()}]`, ...args);
  }

  async function tick(): Promise<void> {
    const frames = await fetchMultiTimeframe(ASSET, "scalping", undefined, {
      rebaseToLive: false,
    });
    const m5 = frames.primary;
    if (!m5?.length) {
      log("no candles");
      return;
    }

    const db = getLiveStrategyDb();
    const last = m5[m5.length - 1];
    const d = ASSETS[ASSET].decimals;

    if (openTrade) {
      const hit = resolveBarOutcome(openTrade.direction, openTrade.sl, openTrade.tp1, last);
      if (hit) {
        updateStrategyOutcome(db, openTrade.id, hit, hit === "TP1_HIT" ? 1 : -1, Date.now());
        log("resolved", openTrade.direction, hit);
        openTrade = null;
      }
    }

    if (openTrade) return;
    if (Date.now() - lastAlertAt < COOLDOWN_MS) return;

    let sig;
    try {
      sig = emit(cfg.strategy, m5);
    } catch (e) {
      log("engine:", e instanceof Error ? e.message : e);
      return;
    }
    if (!sig) return;

    const row = makeStrategyRow({
      strategy: cfg.strategy,
      direction: sig.direction,
      entry: sig.entry,
      sl: sig.sl,
      tp1: sig.tp1,
      tp2: sig.tp2,
      reason: sig.reason,
      time: sig.time,
      symbol: ASSET,
      source: "live",
    });
    insertStrategyRow(db, row);
    openTrade = row;
    lastAlertAt = Date.now();

    const body = [
      `${sig.direction} @ ${sig.entry.toFixed(d)}`,
      `SL ${sig.sl.toFixed(d)} · TP1 ${sig.tp1.toFixed(d)} · TP2 ${sig.tp2.toFixed(d)}`,
      ...sig.reason,
    ].join("\n");

    log("SIGNAL >>>", sig.direction, sig.entry);
    await dispatchTradeAlert({
      kind: "PLAN_LOCK",
      assetId: ASSET,
      mode: cfg.modeLabel,
      side: sig.direction,
      title: "SETUP",
      body,
      tagPrefix: cfg.tagPrefix,
    });
  }

  function start(): void {
    if (workerRunning) {
      log("already running");
      return;
    }
    workerRunning = true;
    log(`started — Gold M5, tag ${cfg.tagPrefix}`);
    void (async () => {
      for (;;) {
        try {
          await tick();
        } catch (e) {
          log("tick fatal:", e instanceof Error ? e.message : e);
        }
        await new Promise((r) => setTimeout(r, cfg.tickMs));
      }
    })();
  }

  function shouldAutoStart(): boolean {
    const flag = (process.env[cfg.envFlag] ?? "auto").toLowerCase();
    if (flag === "0" || flag === "false" || flag === "off") return false;
    if (flag === "1" || flag === "true" || flag === "on") return true;
    return Boolean(process.env.RAILWAY_ENVIRONMENT);
  }

  return { start, shouldAutoStart, tick };
}
