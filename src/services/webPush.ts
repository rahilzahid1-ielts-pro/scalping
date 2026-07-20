/**
 * Web Push channel (VAPID-based, via the `web-push` library).
 *
 * Fully independent of Telegram: missing VAPID keys disable ONLY this channel
 * and never throw into the alert loop. Notifications are delivered to every
 * browser stored in the push-subscriptions DB and reach the phone even when the
 * tab/browser is closed (handled by public/sw.js's `push` listener).
 */
import webpush from "web-push";
import type { TradeAlertPayload } from "./notify";
import {
  getAllPushSubscriptions,
  removePushSubscription,
} from "../push/subscriptionsDb";

let vapidReady = false;
let vapidInitTried = false;

export function getVapidPublicKey(): string {
  return process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() ?? "";
}

function getVapidPrivateKey(): string {
  return process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() ?? "";
}

function getVapidContact(): string {
  const raw = process.env.WEB_PUSH_CONTACT?.trim();
  if (!raw) return "mailto:alerts@scalping.local";
  return raw.startsWith("mailto:") || raw.startsWith("http") ? raw : `mailto:${raw}`;
}

export function isWebPushConfigured(): boolean {
  return Boolean(getVapidPublicKey() && getVapidPrivateKey());
}

/** Idempotently register VAPID details with the web-push lib. */
function ensureVapid(): boolean {
  if (vapidReady) return true;
  if (!isWebPushConfigured()) return false;
  if (vapidInitTried && !vapidReady) {
    // previous init failed; retry once in case env changed
  }
  vapidInitTried = true;
  try {
    webpush.setVapidDetails(getVapidContact(), getVapidPublicKey(), getVapidPrivateKey());
    vapidReady = true;
    return true;
  } catch (e) {
    console.error("[webPush] invalid VAPID keys:", e instanceof Error ? e.message : e);
    vapidReady = false;
    return false;
  }
}

export function webPushStatus() {
  let subscriptions = 0;
  try {
    subscriptions = getAllPushSubscriptions().length;
  } catch {
    /* db not ready */
  }
  return {
    webPush: isWebPushConfigured(),
    webPushSubscriptions: subscriptions,
  };
}

interface PushMessageBody {
  kind: TradeAlertPayload["kind"];
  title: string;
  body: string;
  tag: string;
  assetId: string;
  mode: string;
  side: string;
  ts: number;
}

/**
 * Send a trade alert to every stored browser subscription.
 * Expired/invalid endpoints (404/410) are pruned automatically.
 * Returns the number of notifications successfully delivered.
 */
export async function sendWebPushToAll(payload: TradeAlertPayload): Promise<number> {
  if (!ensureVapid()) return 0;

  let subs;
  try {
    subs = getAllPushSubscriptions();
  } catch (e) {
    console.error("[webPush] failed to read subscriptions:", e instanceof Error ? e.message : e);
    return 0;
  }
  if (subs.length === 0) return 0;

  const message: PushMessageBody = {
    kind: payload.kind,
    title: payload.title,
    body: payload.body,
    tag: `${payload.kind}:${payload.assetId}:${payload.mode}`,
    assetId: payload.assetId,
    mode: payload.mode,
    side: payload.side,
    ts: Date.now(),
  };
  const json = JSON.stringify(message);

  let delivered = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          },
          json,
          { TTL: 86_400, urgency: "high" },
        );
        delivered += 1;
      } catch (e: unknown) {
        const status = (e as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          // Subscription gone/expired — prune it, don't crash the loop.
          removePushSubscription(sub.endpoint);
          console.log("[webPush] pruned expired subscription");
        } else {
          console.error(
            "[webPush] send failed:",
            status ?? "",
            e instanceof Error ? e.message : e,
          );
        }
      }
    }),
  );
  return delivered;
}
