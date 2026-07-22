import type { AssetId, LiveSignal, LiveQuote } from "../types";
import { ASSETS } from "../config/assets";

interface Props {
  signal: LiveSignal;
  livePrice: number;
  quote?: LiveQuote | null;
  assetId: AssetId;
}

/**
 * Live engine lean while a locked Intraday/Scalp trade is still OPEN.
 * Informational only — does not replace the 1-zone lock.
 */
export function WatchSetupCard({ signal, livePrice, assetId }: Props) {
  const asset = ASSETS[assetId];
  const d = asset.decimals;
  const side = signal.side;
  const levels = signal.levels;
  const tone =
    side === "BUY" ? "enter-buy" : side === "SELL" ? "enter-sell" : "wait";

  if (side === "WAIT" || !levels) return null;

  const entry = levels.entry;
  const dist = livePrice - entry;
  const toward =
    side === "BUY"
      ? livePrice >= entry
        ? "price entry ke upar / near"
        : `entry se ${Math.abs(dist).toFixed(d)} neeche`
      : livePrice <= entry
        ? "price entry ke neeche / near"
        : `entry se ${Math.abs(dist).toFixed(d)} upar`;

  const missed =
    (side === "BUY" && livePrice > entry + 3) ||
    (side === "SELL" && livePrice < entry - 3);

  return (
    <section className={`action-now tone-${tone} watch-setup`}>
      <p className="action-now-label">LIVE WATCH · NAYA SETUP</p>
      <h2 className="action-now-headline">{side} SETUP</h2>
      <p className="action-now-sub">
        Upar wala locked trade alag hai — ye sirf live lean hai (auto-lock nahi · 1
        zone/din)
      </p>

      <div className="action-now-scores">
        <div>
          <span>Confidence</span>
          <strong>{signal.confidence}%</strong>
        </div>
        <div>
          <span>Win chance</span>
          <strong className="win">
            {signal.rangePrediction.winProbability}%
          </strong>
        </div>
        <div>
          <span>Live mid</span>
          <strong>{livePrice.toFixed(d)}</strong>
        </div>
      </div>

      <p className="action-now-detail">
        {missed
          ? `Lean ${side} @ ${entry.toFixed(d)} — ab price door (${toward}). Watch only; chase mat karo. Locked trade manage karo.`
          : `Lean ${side} @ ${entry.toFixed(d)} — ${toward}. Informational; is setup pe naya lock nahi lagega jab tak active trade / 1-zone rule clear na ho.`}
      </p>

      <div className="action-now-levels">
        <div>
          <span>Entry</span>
          <strong>{entry.toFixed(d)}</strong>
        </div>
        <div>
          <span>SL</span>
          <strong className="sl">{levels.stopLoss.toFixed(d)}</strong>
        </div>
        <div>
          <span>TP1</span>
          <strong className="tp">{levels.takeProfit1.toFixed(d)}</strong>
        </div>
        <div>
          <span>TP2</span>
          <strong className="tp">{levels.takeProfit2.toFixed(d)}</strong>
        </div>
      </div>
    </section>
  );
}
