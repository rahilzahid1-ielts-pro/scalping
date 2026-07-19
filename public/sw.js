/* Background notification helper — page can message this SW when tab is hidden */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || (data.type !== "ENTRY_ALERT" && data.type !== "PLAN_LOCK_ALERT")) return;
  event.waitUntil(
    self.registration.showNotification(data.title || "TRADE ALERT", {
      body: data.body || "",
      tag: data.tag || "trade-alert",
      requireInteraction: true,
      silent: false,
      vibrate: data.type === "PLAN_LOCK_ALERT" ? [150, 80, 150, 80, 150] : [200, 100, 200, 100, 400],
    }),
  );
});

/* Web Push — fires even when NO tab is open (browser/app closed). Payload is the
   JSON sent by src/services/webPush.ts (title, body, tag, kind, mode, side). */
self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: "TRADE ALERT", body: event.data.text() };
    }
  }
  const isLock = data.kind === "PLAN_LOCK";
  const title = data.title || "TRADE ALERT";
  const body = data.body || "";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data.tag || "trade-alert",
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: isLock ? [150, 80, 150, 80, 150] : [200, 100, 200, 100, 400],
      data: { url: "/" },
    }),
  );
});

/* If the push subscription is rotated by the browser, re-subscribe and tell the
   backend so alerts keep flowing without user interaction. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch("/api/push/public-key");
        const { publicKey } = await res.json();
        if (!publicKey) return;
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sub),
        });
      } catch (e) {
        /* best-effort; page will re-subscribe on next open */
      }
    })(),
  );
});

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = self.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    }),
  );
});
