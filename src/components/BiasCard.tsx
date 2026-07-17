import type { BiasForecast } from "../types";
import { ASSETS } from "../config/assets";
import type { AssetId } from "../types";

interface Props {
  title: string;
  forecast: BiasForecast;
  assetId: AssetId;
}

export function BiasCard({ title, forecast, assetId }: Props) {
  const decimals = ASSETS[assetId].decimals;
  const tone = forecast.bias.toLowerCase();

  return (
    <section className={`panel bias-card bias-${tone}`}>
      <div className="panel-head">
        <h3>{title}</h3>
        <span className={`bias-pill ${tone}`}>{forecast.bias}</span>
      </div>
      <div className="bias-meta">
        <div>
          <span className="label">Confidence</span>
          <strong>{forecast.confidence}%</strong>
        </div>
        <div>
          <span className="label">Start zone</span>
          <strong>{forecast.startZone.toFixed(decimals)}</strong>
        </div>
        <div>
          <span className="label">Key level</span>
          <strong>{forecast.keyLevel.toFixed(decimals)}</strong>
        </div>
      </div>
      <ul className="rationale">
        {forecast.rationale.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </section>
  );
}
