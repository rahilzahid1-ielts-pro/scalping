/* Background notification helper — page can message this SW when tab is hidden */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "ENTRY_ALERT") return;
  event.waitUntil(
    self.registration.showNotification(data.title || "ENTRY ALERT", {
      body: data.body || "",
      tag: data.tag || "entry-alert",
      requireInteraction: true,
      silent: false,
      vibrate: [200, 100, 200, 100, 400],
    }),
  );
});

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
