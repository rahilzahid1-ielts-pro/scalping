import type { AssetId, RangePrediction } from "../types";
import { ASSETS } from "../config/assets";

interface Props {
  prediction: RangePrediction;
  assetId: AssetId;
}

export function PredictionPanel({ prediction: p, assetId }: Props) {
  const decimals = ASSETS[assetId].decimals;
  const tone = p.direction.toLowerCase();

  return (
    <section className={`panel prediction-panel bias-${tone}`}>
      <div className="panel-head">
        <h3>Path Prediction (locked)</h3>
        <span className={`bias-pill ${tone}`}>{p.direction}</span>
      </div>

      <div className="path-banner">
        <div className="path-from">
          <span className="label">From</span>
          <strong>{p.from.toFixed(decimals)}</strong>
        </div>
        <div className="path-arrow" aria-hidden>
          →
        </div>
        <div className="path-to">
          <span className="label">To (target)</span>
          <strong>{p.to.toFixed(decimals)}</strong>
        </div>
      </div>

      <div className="pred-scores">
        <div>
          <span className="label">Confidence</span>
          <strong>{p.confidence}%</strong>
        </div>
        <div>
          <span className="label">Win probability</span>
          <strong className="win-prob">{p.winProbability}%</strong>
        </div>
        <div>
          <span className="label">RSI(14)</span>
          <strong>{p.rsi}</strong>
        </div>
        <div>
          <span className="label">ATR reach</span>
          <strong>{p.atrReach.toFixed(decimals)}</strong>
        </div>
      </div>

      <p className="pred-summary">{p.summary}</p>
      <p className="tf-hint">{p.horizon}</p>

      <div className="pred-levels">
        <div>
          <span>Magnet</span>
          <strong>{p.magnetLevel.toFixed(decimals)}</strong>
        </div>
        <div>
          <span>Invalidation</span>
          <strong className="tone-sell-text">{p.invalidation.toFixed(decimals)}</strong>
        </div>
        <div>
          <span>Pivot PP</span>
          <strong>{p.pivots.pp.toFixed(decimals)}</strong>
        </div>
        <div>
          <span>R1 / S1</span>
          <strong>
            {p.pivots.r1.toFixed(decimals)} / {p.pivots.s1.toFixed(decimals)}
          </strong>
        </div>
      </div>

      <ul className="rationale">
        {p.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </section>
  );
}
