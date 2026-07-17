import { useEffect, useRef } from "react";
import type { NowActionResult } from "../utils/nowAction";

export function useServiceWorkerAlerts(now: NowActionResult | null, enabled: boolean, planKey: string) {
  const fired = useRef<string | null>(null);
  const regRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js").then((reg) => {
      regRef.current = reg;
    });
  }, []);

  useEffect(() => {
    fired.current = null;
  }, [planKey]);

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
