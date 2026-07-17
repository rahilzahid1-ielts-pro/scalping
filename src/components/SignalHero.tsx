import type { LiveSignal, LiveQuote } from "../types";
import { ASSETS } from "../config/assets";

interface Props {
  signal: LiveSignal;
  quote: LiveQuote | null;
  tickAgeMs?: number;
}

export function SignalHero({ signal, quote, tickAgeMs }: Props) {
  const asset = ASSETS[signal.asset];
  const sideClass =
    signal.side === "BUY" ? "buy" : signal.side === "SELL" ? "sell" : "wait";
  const decimals = asset.decimals;
  const display = quote?.price ?? signal.price;
  const fresh = tickAgeMs != null && tickAgeMs < 3000;

  return (
    <section className={`signal-hero side-${sideClass}`}>
      <div className="signal-hero-top">
        <div>
          <p className="eyebrow">{asset.symbol} · {signal.mode.toUpperCase()}</p>
          <h2 className="signal-side">{signal.side}</h2>
          <p className="signal-price">
            Mid @{" "}
            <span className={fresh ? "price-flash" : undefined}>
              {display.toFixed(decimals)}
            </span>
            {fresh && <span className="tick-live"> LIVE</span>}
          </p>
          {quote?.bid != null && quote?.ask != null && (
            <div className="book-row">
              <span className="bid">Bid {quote.bid.toFixed(decimals)}</span>
              <span className="spread">
                Spr {(quote.spread ?? quote.ask - quote.bid).toFixed(decimals)}
              </span>
              <span className="ask">Ask {quote.ask.toFixed(decimals)}</span>
            </div>
          )}
          <p className="price-source">
            {quote?.source ?? "—"} · chart pe blue=Ask / red=Bid (broker spread)
          </p>
        </div>
        <div className="confidence-ring" style={{ ["--p" as string]: `${signal.confidence}` }}>
          <div className="confidence-inner">
            <strong>{signal.confidence}%</strong>
            <span>Confidence</span>
          </div>
        </div>
      </div>
      <p className="action-plan">{signal.actionPlan}</p>
      <p className="tf-hint">{signal.timeframeHint}</p>
    </section>
  );
}
