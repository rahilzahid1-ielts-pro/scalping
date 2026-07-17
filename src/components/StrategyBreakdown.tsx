import type { LiveSignal } from "../types";

interface Props {
  signal: LiveSignal;
}

export function StrategyBreakdown({ signal }: Props) {
  return (
    <section className="panel">
      <h3>Strategy Confluence</h3>
      <div className="strat-grid">
        <div className="strat-block">
          <h4>Moving Averages</h4>
          <p className={`bias-inline ${signal.ma.trend.toLowerCase()}`}>{signal.ma.trend}</p>
          <p className="mono">
            EMA9 {signal.ma.ema9.toFixed(2)} · EMA21 {signal.ma.ema21.toFixed(2)}
          </p>
          <p className="mono">
            EMA50 {signal.ma.ema50.toFixed(2)} · EMA200 {signal.ma.ema200.toFixed(2)}
          </p>
          <ul>
            {signal.ma.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
        <div className="strat-block">
          <h4>Smart Money</h4>
          <p className={`bias-inline ${signal.smc.structure.toLowerCase()}`}>
            {signal.smc.structure}
          </p>
          <p className="mono">
            BOS {signal.smc.bos} · CHoCH {signal.smc.choch} · {signal.smc.premiumDiscount}
          </p>
          <ul>
            {signal.smc.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
        <div className="strat-block">
          <h4>Price Action</h4>
          <p className={`bias-inline ${signal.priceAction.bias.toLowerCase()}`}>
            {signal.priceAction.pattern}
          </p>
          <ul>
            {signal.priceAction.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="confluence-list">
        <h4>Live confluence scorecard</h4>
        <ul>
          {signal.confluence.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
