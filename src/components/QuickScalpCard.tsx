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
    dailyTrend: string;
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

export function QuickScalpCard() {
  const [data, setData] = useState<LatestPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetch("/api/quickscalp/latest")
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
  const tone = latest?.direction === "BUY" ? "enter-buy" : latest?.direction === "SELL" ? "enter-sell" : "wait";

  return (
    <section className={`action-now tone-${tone}`}>
      <p className="action-now-label">QUICK SCALP · BLITZ · Gold</p>
      <h2 className="action-now-headline">
        {latest ? `${latest.direction}` : "WAITING"}
      </h2>
      <p className="action-now-sub">
        Trend-only SMC · conf≥75 · HTF aligned · TP1 @ 0.85R (foran bank / exit)
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
          Range / weak / conflict mein signal nahi. Jab TREND_UP/DOWN + daily agree +
          conf≥75 ho tab BLITZ fire — entry lo, TP1 pe foran nikal jao.
        </p>
      )}

      {latest && (
        <>
          <p className="action-now-detail" style={{ marginBottom: "0.5rem" }}>
            BLITZ: TP1 pe bank karke exit. Badi lot sirf chhote SL distance pe —
            risk aapki zimmedari.
          </p>
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
              <span>TP1 (fast)</span>
              <strong className="tp">{latest.tp1.toFixed(2)}</strong>
            </div>
            <div>
              <span>TP2</span>
              <strong className="tp">{latest.tp2.toFixed(2)}</strong>
            </div>
          </div>
          <p className="action-now-detail">
            Daily: {latest.dailyTrend} · Outcome: {latest.outcome} ·{" "}
            {new Date(latest.timestamp).toLocaleString()}
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
