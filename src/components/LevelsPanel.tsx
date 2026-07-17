import type { LiveSignal, TradeLevels } from "../types";
import type { FrozenPlan } from "../services/tradePlan";
import { ASSETS } from "../config/assets";

interface Props {
  signal: LiveSignal;
  plan: FrozenPlan | null;
  levels: TradeLevels | null;
  livePrice: number | null;
  onNewPlan: () => void;
}

export function LevelsPanel({ signal, plan, levels, livePrice, onNewPlan }: Props) {
  const decimals = ASSETS[signal.asset].decimals;
  const active = plan && plan.status !== "INVALIDATED" ? plan.levels : levels;

  if (!active) {
    return (
      <section className="panel">
        <h3>Trade Plan (Entry · SL · TP)</h3>
        <p className="muted">No plan while WAIT. Wait for BUY/SELL confluence.</p>
      </section>
    );
  }

  const dist =
    livePrice != null
      ? livePrice - active.entry
      : null;

  const rows = [
    { label: "ENTRY (limit here)", value: active.entry, tone: "neutral" },
    { label: "Stop Loss", value: active.stopLoss, tone: "sell" },
    { label: "Take Profit 1", value: active.takeProfit1, tone: "buy" },
    { label: "Take Profit 2", value: active.takeProfit2, tone: "buy" },
    { label: "Take Profit 3", value: active.takeProfit3, tone: "buy" },
    { label: "Invalidation", value: active.invalidation, tone: "sell" },
  ];

  const side = plan?.side ?? signal.side;
  const lockedAt = plan
    ? new Date(plan.lockedAt).toLocaleTimeString()
    : "—";

  return (
    <section className={`panel plan-panel status-${plan?.status ?? "open"}`}>
      <div className="panel-head">
        <h3>
          {side} Plan — FROZEN
        </h3>
        <span className="badge">R:R {active.riskReward.toFixed(2)}</span>
      </div>

      <p className="plan-lock-msg">
        Locked at {lockedAt}. <strong>Isi entry se lo</strong> — live mid chase mat karo.
      </p>

      <div className="plan-alert">
        <strong>Agar pehle se trade le chuke ho:</strong> purani entry / SL / TP follow
        karo. Screen pe naya number aaye to ignore — pehle wala plan hi valid hai jab tak
        SL na toote.
      </div>

      {plan?.note && <p className="plan-note">{plan.note}</p>}

      {dist != null && (
        <p className="plan-distance mono">
          Live mid {livePrice!.toFixed(decimals)} · entry se{" "}
          {dist >= 0 ? "+" : ""}
          {dist.toFixed(decimals)}{" "}
          {side === "BUY"
            ? dist > 0
              ? "(price entry ke upar — pullback wait)"
              : "(entry zone / uske neeche)"
            : dist < 0
              ? "(price entry ke neeche — rally wait)"
              : "(entry zone / uske upar)"}
        </p>
      )}

      <div className="levels-grid">
        {rows.map((r) => (
          <div key={r.label} className={`level-row tone-${r.tone}`}>
            <span>{r.label}</span>
            <strong>{r.value.toFixed(decimals)}</strong>
          </div>
        ))}
      </div>

      <div className="plan-actions">
        <button type="button" className="new-plan-btn" onClick={onNewPlan}>
          New plan (sirf jab pehla cancel / SL hit)
        </button>
      </div>
    </section>
  );
}
