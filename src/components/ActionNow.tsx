import type { NowActionResult } from "../utils/nowAction";
import type { AssetId } from "../types";
import { ASSETS } from "../config/assets";

interface Props {
  now: NowActionResult;
  assetId: AssetId;
  alertsOn: boolean;
  onToggleAlerts: () => void;
  onTestSound: () => void;
}

export function ActionNow({ now, assetId, alertsOn, onToggleAlerts, onTestSound }: Props) {
  const asset = ASSETS[assetId];
  const d = asset.decimals;
  const tone =
    now.action === "ENTER_NOW"
      ? now.side === "BUY"
        ? "enter-buy"
        : "enter-sell"
      : now.action === "WAIT_ENTRY"
        ? "wait-entry"
        : now.action === "PLAN_DEAD" || now.action === "TOO_LATE"
          ? "dead"
          : "wait";

  return (
    <section className={`action-now tone-${tone} ${now.action === "ENTER_NOW" ? "pulse-alert" : ""}`}>
      <p className="action-now-label">AB RIGHT NOW</p>
      <h2 className="action-now-headline">{now.headlineUr}</h2>
      <p className="action-now-sub">{now.headline}</p>

      <div className="action-now-scores">
        <div>
          <span>Confidence</span>
          <strong>{now.confidence}%</strong>
        </div>
        <div>
          <span>Win chance</span>
          <strong className="win">{now.winProbability}%</strong>
        </div>
        <div>
          <span>Live mid</span>
          <strong>{now.livePrice.toFixed(d)}</strong>
        </div>
      </div>

      <p className="action-now-detail">{now.detail}</p>

      {now.conflictingSignals && (
        <div className="conflict-flag">
          ⚠ Conflicting signals — MA/SMC opposes this call. Confidence capped (≤65%). Low-quality setup.
        </div>
      )}

      {now.entry != null && (
        <div className="action-now-levels">
          <div>
            <span>Entry</span>
            <strong>{now.entry.toFixed(d)}</strong>
          </div>
          <div>
            <span>SL</span>
            <strong className="sl">{now.stopLoss?.toFixed(d)}</strong>
          </div>
          <div>
            <span>TP1</span>
            <strong className="tp">{now.takeProfit?.toFixed(d)}</strong>
          </div>
        </div>
      )}

      {now.action === "ENTER_NOW" && (
        <div className="alert-banner">🔔 ENTRY ZONE — ALERT ON</div>
      )}

      {now.action === "WAIT_ENTRY" && now.distanceToEntry != null && (
        <div className="distance-bar">
          <span>Entry se doori</span>
          <strong>
            {now.distanceToEntry >= 0 ? "+" : ""}
            {now.distanceToEntry.toFixed(d)}
          </strong>
        </div>
      )}

      <div className="alert-controls">
        <button type="button" className={alertsOn ? "active" : ""} onClick={onToggleAlerts}>
          {alertsOn ? "🔔 Alerts ON" : "🔕 Alerts OFF"}
        </button>
        <button type="button" onClick={onTestSound}>
          Test sound
        </button>
      </div>
    </section>
  );
}
