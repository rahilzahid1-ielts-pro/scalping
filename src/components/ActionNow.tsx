import type { NowActionResult } from "../utils/nowAction";
import type { AssetId } from "../types";
import { ASSETS } from "../config/assets";

import type { PushState } from "../services/pushClient";

interface Props {
  now: NowActionResult;
  assetId: AssetId;
  alertsOn: boolean;
  onToggleAlerts: () => void;
  onTestSound: () => void;
  pushState: PushState;
  onEnablePush: () => void;
}

const PUSH_LABEL: Record<PushState, string> = {
  unsupported: "Push N/A",
  default: "🔔 Enable Push",
  denied: "Push Blocked",
  granted: "🔔 Enable Push",
  subscribed: "✅ Push ON",
};

export function ActionNow({
  now,
  assetId,
  alertsOn,
  onToggleAlerts,
  onTestSound,
  pushState,
  onEnablePush,
}: Props) {
  const asset = ASSETS[assetId];
  const d = asset.decimals;
  const tone =
    now.action === "ENTER_NOW"
      ? now.side === "BUY"
        ? "enter-buy"
        : "enter-sell"
      : now.action === "TRADE_ACTIVE"
        ? now.side === "BUY"
          ? "active-buy"
          : "active-sell"
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

      {now.liquidityWarning && (
        <div className="liquidity-flag">
          Liquidity sweep detected mid-plan — informational. Levels and confidence unchanged.
        </div>
      )}

      {now.entry != null && (
        <div className="action-now-levels">
          {now.entryZoneLow != null && now.entryZoneHigh != null ? (
            <div className="zone-span">
              <span>Entry zone</span>
              <strong>
                {Math.min(now.entryZoneLow, now.entryZoneHigh).toFixed(d)}–
                {Math.max(now.entryZoneLow, now.entryZoneHigh).toFixed(d)}
              </strong>
            </div>
          ) : (
            <div>
              <span>Entry</span>
              <strong>{now.entry.toFixed(d)}</strong>
            </div>
          )}
          <div>
            <span>SL</span>
            <strong className="sl">{now.stopLoss?.toFixed(d)}</strong>
          </div>
          <div>
            <span>TP1</span>
            <strong className="tp">{now.takeProfit?.toFixed(d)}</strong>
          </div>
          {now.takeProfit2 != null && (
            <div>
              <span>TP2</span>
              <strong className="tp">{now.takeProfit2.toFixed(d)}</strong>
            </div>
          )}
        </div>
      )}

      {now.sessionLocked && now.safeZoneLow != null && now.safeZoneHigh != null && (
        <div className="session-safe-zone">
          <span>Safe zone (din bhar)</span>
          <strong>
            {Math.min(now.safeZoneLow, now.safeZoneHigh).toFixed(d)}–
            {Math.max(now.safeZoneLow, now.safeZoneHigh).toFixed(d)}
          </strong>
        </div>
      )}

      {now.sessionLocked && now.action === "WAIT_ENTRY" && (
        <div className="alert-banner session-lock">📌 INTRADAY ZONE LOCKED — levels refresh se nahi badlenge</div>
      )}

      {now.action === "ENTER_NOW" && (
        <div className="alert-banner">🔔 ENTRY ZONE — ALERT ON</div>
      )}

      {now.action === "TRADE_ACTIVE" && (
        <div className="alert-banner">🔒 ACTIVE TRADE — PLAN CHANGE BLOCKED</div>
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
        <button
          type="button"
          className={pushState === "subscribed" ? "active" : ""}
          onClick={onEnablePush}
          disabled={pushState === "unsupported" || pushState === "denied"}
          title={
            pushState === "denied"
              ? "Notifications blocked — enable them in browser/site settings"
              : pushState === "unsupported"
                ? "This browser doesn't support push notifications"
                : "Get trade alerts on your phone even when the app is closed"
          }
        >
          {PUSH_LABEL[pushState]}
        </button>
        <button type="button" onClick={onTestSound}>
          Test sound
        </button>
      </div>
    </section>
  );
}
