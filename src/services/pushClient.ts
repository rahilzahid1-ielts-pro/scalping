/**
 * Browser-side Web Push helper (no Node deps — safe to bundle into the client).
 * Handles permission, PushManager subscription, and syncing the subscription to
 * the backend (/api/push/subscribe). Works alongside the existing in-page alerts.
 */

export type PushState =
  | "unsupported" // browser lacks SW/Push/Notification
  | "default" // permission not yet requested
  | "denied" // user blocked notifications
  | "granted" // permission granted but not subscribed
  | "subscribed"; // permission granted + active push subscription

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    // useServiceWorkerAlerts registers /sw.js; wait until it's active.
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

export async function getPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const perm = Notification.permission;
  if (perm === "denied") return "denied";
  if (perm === "default") return "default";
  // granted — check for an existing subscription
  const reg = await getRegistration();
  if (!reg) return "granted";
  try {
    const sub = await reg.pushManager.getSubscription();
    return sub ? "subscribed" : "granted";
  } catch {
    return "granted";
  }
}

async function fetchPublicKey(): Promise<string> {
  const res = await fetch("/api/push/public-key");
  if (!res.ok) throw new Error(`public-key ${res.status}`);
  const data = (await res.json()) as { ok: boolean; publicKey?: string };
  if (!data.publicKey) throw new Error("Server has no VAPID public key configured");
  return data.publicKey;
}

/**
 * Full opt-in flow: request permission → subscribe via PushManager → POST to backend.
 * Returns the resulting state (and an error message on failure).
 */
export async function enablePush(): Promise<{ state: PushState; error?: string }> {
  if (!pushSupported()) return { state: "unsupported", error: "Browser doesn't support push" };

  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm === "denied") return { state: "denied", error: "Notifications blocked" };
  if (perm !== "granted") return { state: "default" };

  const reg = await getRegistration();
  if (!reg) return { state: "granted", error: "Service worker not ready" };

  try {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const publicKey = await fetchPublicKey();
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });
    if (!res.ok) throw new Error(`subscribe ${res.status}`);
    return { state: "subscribed" };
  } catch (e) {
    return { state: "granted", error: e instanceof Error ? e.message : "subscribe failed" };
  }
}

export async function disablePush(): Promise<void> {
  const reg = await getRegistration();
  if (!reg) return;
  try {
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => undefined);
    await sub.unsubscribe();
  } catch {
    /* ignore */
  }
}
