import { useEffect, useState } from "react";

interface LatestPayload {
  ok: boolean;
  validated: boolean;
  badge: string | null;
  latest: {
    direction: "BUY" | "SELL";
    entry: number;
    sl: number;
    tp1: number;
    tp2: number;
    confidence: number;
    regime: string;
    dailyBias: string;
    reason: string;
    outcome: string;
    timestamp: number;
  } | null;
  backtestSummary: {
    resolved: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgR: number | null;
    maxDrawdownR: number | null;
  } | null;
}

function parseReasons(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return raw ? [raw] : [];
  }
}

export function ProCard() {
  const [data, setData] = useState<LatestPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetch("/api/pro/latest")
        .then((r) => r.json())
        .then((j: LatestPayload) => {
          if (!cancelled) {
            setData(j);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : "fetch failed");
        });
    };
    load();
    const id = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const latest = data?.latest ?? null;
  const reasons = latest ? parseReasons(latest.reason) : [];
  const tone =
    latest?.direction === "BUY"
      ? "enter-buy"
      : latest?.direction === "SELL"
        ? "enter-sell"
        : "wait";

  return (
    <section className={`action-now tone-${tone}`}>
      <p className="action-now-label">PRO · Gold</p>
      <h2 className="action-now-headline">
        {latest ? `${latest.direction}` : "WAITING"}
      </h2>
      <p className="action-now-sub">
        Strict SMC — conf≥80 · HTF aligned · trend only · daily bias agrees
      </p>

      {!data?.validated && (
        <div className="liquidity-flag">
          {data?.badge ?? "UNVALIDATED — no backtest history yet"}
        </div>
      )}

      {data?.validated && data.backtestSummary && (
        <div className="action-now-scores">
          <div>
            <span>Backtest TP1win%</span>
            <strong className="win">
              {data.backtestSummary.winRate == null
                ? "—"
                : `${data.backtestSummary.winRate.toFixed(1)}%`}
            </strong>
          </div>
          <div>
            <span>Avg R</span>
            <strong>
              {data.backtestSummary.avgR == null
                ? "—"
                : data.backtestSummary.avgR.toFixed(2)}
            </strong>
          </div>
          <div>
            <span>n / maxDD</span>
            <strong>
              {data.backtestSummary.resolved}
              {data.backtestSummary.maxDrawdownR != null
                ? ` · ${data.backtestSummary.maxDrawdownR.toFixed(1)}R`
                : ""}
            </strong>
          </div>
        </div>
      )}

      {error && <p className="action-now-detail">{error}</p>}

      {!latest && !error && (
        <p className="action-now-detail">
          Abhi koi Pro setup nahi — sirf high-quality trend + HTF + daily agreement
          pe fire hota hai (kam signals, zyada filter).
        </p>
      )}

      {latest && (
        <>
          <div className="action-now-scores">
            <div>
              <span>Confidence</span>
              <strong>{latest.confidence}%</strong>
            </div>
            <div>
              <span>Regime</span>
              <strong>{latest.regime}</strong>
            </div>
            <div>
              <span>Daily</span>
              <strong>{latest.dailyBias}</strong>
            </div>
          </div>
          <div className="action-now-levels">
            <div>
              <span>Entry</span>
              <strong>{latest.entry.toFixed(2)}</strong>
            </div>
            <div>
              <span>SL</span>
              <strong className="sl">{latest.sl.toFixed(2)}</strong>
            </div>
            <div>
              <span>TP1</span>
              <strong className="tp">{latest.tp1.toFixed(2)}</strong>
            </div>
            <div>
              <span>TP2</span>
              <strong className="tp">{latest.tp2.toFixed(2)}</strong>
            </div>
          </div>
          <p className="action-now-detail">
            Outcome: {latest.outcome} · {new Date(latest.timestamp).toLocaleString()}
          </p>
          {reasons.length > 0 && (
            <ul className="rationale">
              {reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
