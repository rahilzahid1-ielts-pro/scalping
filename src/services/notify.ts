import type { AssetId } from "../types";
import { ASSETS } from "../config/assets";
import { isWebPushConfigured, sendWebPushToAll, webPushStatus } from "./webPush";

export type TradeAlertKind = "PLAN_LOCK" | "ENTRY_HIT";

export interface TradeAlertPayload {
  kind: TradeAlertKind;
  assetId: AssetId;
  mode: string;
  side: string;
  title: string;
  body: string;
  /** Optional channel tag, e.g. "[Quick Scalp]" — prepended so channels stay distinct. */
  tagPrefix?: string;
}

/** Clear labels for notifications: Gold / Silver / Bitcoin */
export function assetLabel(assetId: AssetId): string {
  return ASSETS[assetId]?.name ?? assetId;
}

export function assetEmoji(assetId: AssetId): string {
  if (assetId === "XAUUSD") return "🥇";
  if (assetId === "XAGUSD") return "🥈";
  if (assetId === "BTCUSD") return "₿";
  return "📈";
}

export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export function alertChannelsStatus() {
  let webPush = false;
  let webPushSubscriptions = 0;
  try {
    const s = webPushStatus();
    webPush = s.webPush;
    webPushSubscriptions = s.webPushSubscriptions;
  } catch {
    /* web-push not available — leave defaults */
  }
  return {
    telegram: isTelegramConfigured(),
    windows: process.platform === "win32",
    webPush,
    webPushSubscriptions,
    workerEnv: process.env.ENABLE_ALERT_WORKER ?? "auto",
  };
}

/**
 * Send trade alert to Telegram (phone/desktop — web tab ki zaroorat nahi).
 * Returns true if Telegram accepted the message.
 */
export async function sendTelegramAlert(payload: TradeAlertPayload): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return false;

  const label = assetLabel(payload.assetId);
  const emoji = assetEmoji(payload.assetId);
  const kindLabel = payload.kind === "PLAN_LOCK" ? "ZONE / PLAN LOCKED" : "ENTRY HIT — TRADE NOW";
  const prefix = payload.tagPrefix ? `${payload.tagPrefix} ` : "";

  const text = [
    `${emoji} <b>${prefix}${label}</b> · ${kindLabel}`,
    `<b>${payload.side}</b> · ${payload.mode}`,
    "",
    payload.body,
    "",
    `<i>Asset: ${label} (${payload.assetId})</i>`,
  ].join("\n");

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[telegramNotify] HTTP", res.status, errText.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error(
      "[telegramNotify]",
      e instanceof Error ? e.message : e,
    );
    return false;
  }
}

/** Optional Windows toast (local PC only). */
export async function sendWindowsAlert(title: string, body: string): Promise<void> {
  if (process.platform !== "win32") return;
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

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

/** Fan-out: Telegram (Railway/phone) + Web Push (phone, no VPN) + Windows (local). */
export async function dispatchTradeAlert(payload: TradeAlertPayload): Promise<void> {
  const label = assetLabel(payload.assetId);
  const prefix = payload.tagPrefix ? `${payload.tagPrefix} ` : "";
  const titled = {
    ...payload,
    title: `${prefix}${payload.title}`,
  };
  const title = `${label} | ${titled.title}`;
  // Each channel is guarded independently — a failure in one never blocks the others.
  const [tg, push] = await Promise.all([
    sendTelegramAlert(titled).catch((e) => {
      console.error("[notify] telegram error:", e instanceof Error ? e.message : e);
      return false;
    }),
    sendWebPushToAll(titled).catch((e) => {
      console.error("[notify] web-push error:", e instanceof Error ? e.message : e);
      return 0;
    }),
    sendWindowsAlert(title, payload.body).catch(() => undefined),
  ]);
  if (!tg && push === 0 && !isTelegramConfigured() && !isWebPushConfigured() && process.platform !== "win32") {
    console.warn(
      "[notify] No delivery channel — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID or WEB_PUSH_VAPID_* on Railway",
    );
  }
}
