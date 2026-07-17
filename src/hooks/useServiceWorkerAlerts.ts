import { useEffect, useRef } from "react";
import type { NowActionResult } from "../utils/nowAction";
import type { FrozenPlan } from "../services/tradePlan";
import { ASSETS } from "../config/assets";

export function useServiceWorkerAlerts(
  now: NowActionResult | null,
  enabled: boolean,
  planKey: string,
  plan: FrozenPlan | null,
) {
  const fired = useRef<string | null>(null);
  const lockFired = useRef<string | null>(null);
  const regRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js").then((reg) => {
      regRef.current = reg;
    });
  }, []);

  useEffect(() => {
    fired.current = null;
    lockFired.current = null;
  }, [planKey]);

  useEffect(() => {
    if (!enabled || !plan || plan.status === "INVALIDATED") return;
    const key = `${planKey}-plan-lock`;
    if (lockFired.current === key) return;
    lockFired.current = key;

    const d = ASSETS[plan.assetId].decimals;
    const zone =
      plan.entryZoneLow != null && plan.entryZoneHigh != null
        ? `${plan.entryZoneLow.toFixed(d)}–${plan.entryZoneHigh.toFixed(d)}`
        : plan.levels.entry.toFixed(d);
    const title = plan.mode === "intraday" ? "INTRADAY ZONE LOCKED" : "TRADE PLAN LOCKED";
    const body = `${plan.side} zone ${zone} · SL ${plan.levels.stopLoss.toFixed(d)} · TP1 ${plan.levels.takeProfit1.toFixed(d)}`;

    const sw = navigator.serviceWorker?.controller;
    if (sw) {
      sw.postMessage({ type: "PLAN_LOCK_ALERT", title, body, tag: key });
    } else if (regRef.current) {
      void regRef.current.showNotification(title, {
        body,
        tag: key,
        requireInteraction: true,
      });
    }
  }, [plan, enabled, planKey]);

  useEffect(() => {
    if (!enabled || !now || now.action !== "ENTER_NOW" || !now.inEntryZone) return;
    const key = `${planKey}-sw`;
    if (fired.current === key) return;
    fired.current = key;

    const title = now.headlineUr;
    const body = `${now.side} @ ${now.entry} | Live ${now.livePrice} | SL ${now.stopLoss} | TP ${now.takeProfit}`;

    const sw = navigator.serviceWorker?.controller;
    if (sw) {
      sw.postMessage({ type: "ENTRY_ALERT", title, body, tag: key });
    } else if (regRef.current) {
      void regRef.current.showNotification(title, {
        body,
        tag: key,
        requireInteraction: true,
      });
    }
  }, [now, enabled, planKey]);
}
