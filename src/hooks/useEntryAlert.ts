import { useEffect, useRef } from "react";
import type { NowActionResult } from "../utils/nowAction";
import type { FrozenPlan } from "../services/tradePlan";
import { ASSETS } from "../config/assets";

let sharedCtx: AudioContext | null = null;

function getCtx() {
  if (!sharedCtx) {
    sharedCtx = new AudioContext();
  }
  if (sharedCtx.state === "suspended") {
    void sharedCtx.resume();
  }
  return sharedCtx;
}

function playBeep(freq = 880, durationMs = 320, times = 5) {
  try {
    const ctx = getCtx();
    let t = ctx.currentTime;
    for (let i = 0; i < times; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + durationMs / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + durationMs / 1000 + 0.05);
      t += durationMs / 1000 + 0.1;
    }
  } catch {
    /* blocked until gesture */
  }
}

function notifyEntry(now: NowActionResult) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(now.headlineUr, {
      body: `${now.side} ENTRY ${now.entryZoneLow ?? now.entry}–${now.entryZoneHigh ?? now.entry} · SL ${now.stopLoss} · TP ${now.takeProfit}`,
      tag: "entry-alert",
      requireInteraction: true,
    });
  } catch {
    /* ignore */
  }
}

function notifyPlanLocked(plan: FrozenPlan) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const d = ASSETS[plan.assetId].decimals;
  const zone =
    plan.entryZoneLow != null && plan.entryZoneHigh != null
      ? `${plan.entryZoneLow.toFixed(d)}–${plan.entryZoneHigh.toFixed(d)}`
      : plan.levels.entry.toFixed(d);
  const safe =
    plan.safeZoneLow != null && plan.safeZoneHigh != null
      ? ` · Safe ${plan.safeZoneLow.toFixed(d)}–${plan.safeZoneHigh.toFixed(d)}`
      : "";
  try {
    new Notification(
      plan.mode === "intraday" ? "INTRADAY ZONE LOCKED" : "TRADE PLAN LOCKED",
      {
        body: `${plan.side} zone ${zone} · SL ${plan.levels.stopLoss.toFixed(d)} · TP1 ${plan.levels.takeProfit1.toFixed(d)} · TP2 ${plan.levels.takeProfit2.toFixed(d)}${safe}`,
        tag: "plan-lock-alert",
        requireInteraction: true,
      },
    );
  } catch {
    /* ignore */
  }
}

interface Options {
  now: NowActionResult | null;
  enabled: boolean;
  /** Stable key = locked entry only (not live price) */
  planKey: string;
}

export function usePlanLockAlert(plan: FrozenPlan | null, enabled: boolean) {
  const firedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !plan || plan.status === "INVALIDATED") return;
    const key = `${plan.assetId}-${plan.mode}-${plan.lockedAt}-LOCK`;
    if (firedRef.current === key) return;
    firedRef.current = key;
    playBeep(520, 260, 4);
    notifyPlanLocked(plan);
  }, [plan, enabled]);
}

export function useEntryAlert({ now, enabled, planKey }: Options) {
  const firedRef = useRef<string | null>(null);
  const prevAction = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !now) return;
    if (now.action !== "ENTER_NOW") {
      prevAction.current = now.action;
      return;
    }
    const key = `${planKey}-ENTER`;
    // Fire once per locked plan when ENTER_NOW appears
    if (firedRef.current === key) return;
    firedRef.current = key;
    prevAction.current = now.action;
    playBeep(now.side === "BUY" ? 740 : 980, 350, 6);
    notifyEntry(now);
  }, [now, enabled, planKey]);

  useEffect(() => {
    firedRef.current = null;
    prevAction.current = null;
  }, [planKey]);
}

export async function requestAlertPermission() {
  try {
    getCtx(); // unlock audio on user gesture
  } catch {
    /* ignore */
  }
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const p = await Notification.requestPermission();
  return p === "granted";
}

export function testAlertSound() {
  try {
    getCtx();
  } catch {
    /* ignore */
  }
  playBeep(880, 300, 3);
}
