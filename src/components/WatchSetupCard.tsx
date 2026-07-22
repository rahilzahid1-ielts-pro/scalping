import type { NowActionResult } from "../utils/nowAction";
import type { AssetId } from "../types";
import { ASSETS } from "../config/assets";

interface Props {
  now: NowActionResult;
  assetId: AssetId;
}

/**
 * Live engine lean while a locked Intraday/Scalp trade is still OPEN.
 * Informational only — does not replace the 1-zone lock.
 */
export function WatchSetupCard({ now, assetId }: Props) {
  const asset = ASSETS[assetId];
  const d = asset.decimals;
  const tone =
    now.side === "BUY" ? "enter-buy" : now.side === "SELL" ? "enter-sell" : "wait";

  return (
    <section className={`action-now tone-${tone} watch-setup`}>
      <p className="action-now-label">LIVE WATCH · NAYA SETUP</p>
      <h2 className="action-now-headline">
        {now.side === "WAIT" ? "WAITING" : `${now.side} SETUP`}
      </h2>
      <p className="action-now-sub">
        Locked trade alag box me hai — ye sirf live engine lean hai (auto-lock nahi,
        1 zone/din)
      </p>

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
          {now.takeProfit2 != null && (
            <div>
              <span>TP2</span>
              <strong className="tp">{now.takeProfit2.toFixed(d)}</strong>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
