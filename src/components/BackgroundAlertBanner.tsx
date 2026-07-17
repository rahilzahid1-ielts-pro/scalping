import { useEffect, useState } from "react";

interface Props {
  onStartHint: () => void;
}

type AlertStatus = {
  telegramConfigured?: boolean;
  telegram?: boolean;
  windows?: boolean;
  workerWillAutoStart?: boolean;
  hint?: string;
};

export function BackgroundAlertBanner({ onStartHint }: Props) {
  const [status, setStatus] = useState<AlertStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/alerts/status")
      .then((r) => r.json())
      .then((j: AlertStatus & { ok?: boolean }) => {
        if (!cancelled) setStatus(j);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tgOn = Boolean(status?.telegramConfigured ?? status?.telegram);

  return (
    <section className="panel bg-alert-banner">
      <h3>Live alerts — Gold · Silver · Bitcoin</h3>
      {tgOn ? (
        <>
          <p className="tg-on">
            Telegram ON — web band / phone lock pe bhi signal notification aayegi.
            Har alert mein clearly likha hoga: <strong>Gold</strong>,{" "}
            <strong>Silver</strong>, ya <strong>Bitcoin</strong>.
          </p>
          <p className="muted">
            2 alerts: (1) zone/plan lock (2) jab price entry pe aaye. Browser open
            rakhne ki zaroorat nahi.
          </p>
        </>
      ) : (
        <>
          <p>
            Web band hone pe alerts ke liye Railway pe Telegram connect karo:
          </p>
          <ol className="alert-setup-steps">
            <li>
              Telegram pe <code>@BotFather</code> → <code>/newbot</code> → token
              copy
            </li>
            <li>
              Apne bot ko message bhejo, phir chat id lo (
              <code>@userinfobot</code> ya getUpdates)
            </li>
            <li>
              Railway → Variables:
              <pre className="cmd-box">{`TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
ENABLE_ALERT_WORKER=1`}</pre>
            </li>
            <li>Redeploy — phir phone pe Gold/Silver/BTC alerts aayenge</li>
          </ol>
          <p className="muted">
            Local PC pe Windows toast ke liye alag terminal:{" "}
            <code>npm run alerts</code>
          </p>
          <button type="button" className="new-plan-btn" onClick={onStartHint}>
            Copy local command
          </button>
        </>
      )}
      {status?.hint && <p className="muted status-hint">{status.hint}</p>}
    </section>
  );
}
