/**
 * Shared poller factory for compare strategies (cipher_b_clone / fractal / ict).
 * Cipher B + Fractal: indicator trigger + SMC dual-confirm (accuracy pack).
 */
import { ASSETS } from "../config/assets";
import { fetchMultiTimeframe } from "../services/marketData";
import { dispatchTradeAlert } from "../services/notify";
import { generateCipherBLiveSignal } from "../strategies/cipherBLive";
import { generateFractalLiveSignal } from "../strategies/fractalLive";
import { generateIctSignal } from "../strategies/archived/ictSignal";
import { candlesAsUnixSeconds, resolveBarOutcome } from "./resolve";
import {
  getLiveStrategyDb,
  getOpenOrLatestStrategySignal,
  insertStrategyRow,
  makeStrategyRow,
  markStrategyExecuted,
  updateStrategyOutcome,
  type CompareStrategy,
  type StrategySignalRow,
} from "./store";
import type { Candle } from "../types";
import {
  isFreshPendingEntryViable,
  pendingEntryState,
} from "../history/entryTouch";
import { entryTolerance } from "../utils/tradeSafety";
import {
  noteLeanDeskLock,
  shouldSkipCorrelatedLeanLock,
} from "../utils/leanDeskCooldown";

const ASSET = "XAUUSD" as const;
const COOLDOWN_MS = 60 * 60 * 1000;

export interface CompareBotConfig {
  strategy: CompareStrategy;
  tagPrefix: string;
  modeLabel: string;
  tickMs: number;
  envFlag: string;
}

function emit(
  strategy: CompareStrategy,
  frames: {
    primary: Candle[];
    confirmation: Candle[];
    bias: Candle[];
    daily: Candle[];
  },
) {
  if (strategy === "cipher_b_clone") {
    return generateCipherBLiveSignal({ ...frames, assetId: ASSET, mode: "scalping" });
  }
  if (strategy === "fractal") {
    return generateFractalLiveSignal({ ...frames, assetId: ASSET, mode: "scalping" });
  }
  const sig = generateIctSignal({ candles: candlesAsUnixSeconds(frames.primary) });
  if (!sig) return null;
  return { ...sig, time: frames.primary[frames.primary.length - 1].time };
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
      rebaseToLive: true,
    });
    if (!frames.primary?.length || !frames.daily?.length) {
      log("no candles");
      return;
    }

    const db = getLiveStrategyDb();
    const last = frames.primary[frames.primary.length - 1];
    const d = ASSETS[ASSET].decimals;

    if (!openTrade) {
      const resumed = getOpenOrLatestStrategySignal(db, cfg.strategy);
      if (resumed?.outcome === "OPEN") {
        openTrade = resumed;
        log("resumed OPEN", openTrade.direction, openTrade.entry);
      }
    }

    if (openTrade) {
      if (!openTrade.executedAt) {
        const state = pendingEntryState(
          openTrade.direction,
          openTrade.entry,
          openTrade.sl,
          openTrade.tp1,
          openTrade.createdAt,
          last,
          entryTolerance(ASSETS[ASSET], "scalping", last.close),
        );
        if (state === "MISSED") {
          updateStrategyOutcome(db, openTrade.id, "INVALIDATED", 0, Date.now());
          log("invalidated unexecuted stale lock", openTrade.direction, openTrade.entry);
          openTrade = null;
        } else if (state === "EXECUTED") {
          const at = Date.now();
          markStrategyExecuted(db, openTrade.id, at);
          openTrade = { ...openTrade, executedAt: at };
          log("EXECUTED", openTrade.direction, "@", openTrade.entry);
        }
      }
      if (openTrade?.executedAt) {
        const hit = resolveBarOutcome(openTrade.direction, openTrade.sl, openTrade.tp1, last);
        if (hit) {
          const risk = Math.abs(openTrade.entry - openTrade.sl);
          const tp1R =
            risk > 0 ? Math.abs(openTrade.tp1 - openTrade.entry) / risk : 1;
          updateStrategyOutcome(
            db,
            openTrade.id,
            hit,
            hit === "TP1_HIT" ? tp1R : -1,
            Date.now(),
          );
          log("resolved", openTrade.direction, hit);
          openTrade = null;
        }
      }
    }

    if (openTrade) return;

    let sig;
    try {
      sig = emit(cfg.strategy, frames);
    } catch (e) {
      log("engine:", e instanceof Error ? e.message : e);
      return;
    }
    if (!sig) return;
    if (Date.now() - lastAlertAt < COOLDOWN_MS) return;
    if (
      cfg.strategy === "fractal" &&
      shouldSkipCorrelatedLeanLock("fractal", sig.direction, sig.entry)
    ) {
      log("skip correlated lean (QS Pro already locked nearby)");
      return;
    }
    if (
      !isFreshPendingEntryViable(
        sig.direction,
        sig.entry,
        sig.sl,
        sig.tp1,
        last,
        entryTolerance(ASSETS[ASSET], "scalping", last.close),
      )
    ) {
      return;
    }

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
    if (cfg.strategy === "fractal") {
      noteLeanDeskLock("fractal", sig.direction, sig.entry);
    }

    const body = [
      `${sig.direction} @ ${sig.entry.toFixed(d)}`,
      `SL ${sig.sl.toFixed(d)} · TP1 ${sig.tp1.toFixed(d)} · TP2 ${sig.tp2.toFixed(d)}`,
      ...sig.reason.slice(0, 5),
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
    log(`started — Gold dual-confirm, tag ${cfg.tagPrefix}`);
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
