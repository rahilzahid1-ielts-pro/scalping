import { useEffect, useState } from "react";

type Side = "BUY" | "SELL";

interface DayAcc {
  dayKey: string;
  resolved: number;
  correct: number;
  accuracyPct: number | null;
  hiResolved: number;
  hiCorrect: number;
  hiAccuracyPct: number | null;
}

interface ProbebPayload {
  ok: boolean;
  live: {
    side: Side;
    probabilityPct: number;
    confidencePct: number;
    bucket: string;
    sampleN: number;
    barTime: number;
    reason: string[];
  } | null;
  latest: {
    predictedSide: Side;
    probabilityPct: number;
    confidencePct: number;
    actualSide: Side | null;
    correct: number | null;
    barTime: number;
  } | null;
  today: DayAcc;
  lifetime: {
    resolved: number;
    correct: number;
    accuracyPct: number | null;
  };
  walkAccuracy: {
    resolved: number;
    correct: number;
    accuracyPct: number | null;
  } | null;
  recent: Array<{
    predictedSide: Side;
    probabilityPct: number;
    confidencePct: number;
    actualSide: Side | null;
    correct: number | null;
    barTime: number;
  }>;
  waitReason: string | null;
}

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(1)}%`;
}

function pkt(ms: number): string {
  try {
    return new Date(ms).toLocaleString("en-GB", { timeZone: "Asia/Karachi" });
  } catch {
    return String(ms);
  }
}

export function ProbebCard() {
  const [data, setData] = useState<ProbebPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetch("/api/probeb/latest")
        .then((r) => r.json())
        .then((j: ProbebPayload) => {
          if (cancelled) return;
          setData(j);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : "fetch failed");
        });
    };
    load();
    const t = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const live = data?.live;
  const today = data?.today;

  return (
    <div className="card strategy-card">
      <div className="card-head">
        <h2>Probeb</h2>
        <p className="muted">
          Next M5 candle lean · winning % · confidence · rozana accuracy (local,
          no AI API)
        </p>
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}

      {data?.waitReason && !live && (
        <p className="muted">{data.waitReason}</p>
      )}

      {live && (
        <div className="lock-block">
          <div className="side-row">
            <span className={live.side === "BUY" ? "side-buy" : "side-sell"}>
              NEXT {live.side}
            </span>
            <span className="pill">
              Win prob {live.probabilityPct.toFixed(1)}%
            </span>
            <span className="pill">Conf {live.confidencePct}%</span>
          </div>
          <p className="muted">
            Sample n={live.sampleN} · bucket <code>{live.bucket}</code>
          </p>
          <ul className="reason-list">
            {live.reason.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {today && (
        <div className="stats-row" style={{ marginTop: "1rem" }}>
          <div>
            <div className="muted">Aaj ({today.dayKey}) sahi</div>
            <div className="stat-big">
              {today.correct}/{today.resolved}{" "}
              <span className="muted">{pct(today.accuracyPct)}</span>
            </div>
          </div>
          <div>
            <div className="muted">High-conf (≥60)</div>
            <div className="stat-big">
              {today.hiCorrect}/{today.hiResolved}{" "}
              <span className="muted">{pct(today.hiAccuracyPct)}</span>
            </div>
          </div>
          <div>
            <div className="muted">Lifetime</div>
            <div className="stat-big">
              {data?.lifetime.correct ?? 0}/{data?.lifetime.resolved ?? 0}{" "}
              <span className="muted">{pct(data?.lifetime.accuracyPct)}</span>
            </div>
          </div>
          <div>
            <div className="muted">Walk (recent hist)</div>
            <div className="stat-big">
              {data?.walkAccuracy
                ? `${data.walkAccuracy.correct}/${data.walkAccuracy.resolved}`
                : "—"}{" "}
              <span className="muted">
                {pct(data?.walkAccuracy?.accuracyPct)}
              </span>
            </div>
          </div>
        </div>
      )}

      {data?.recent && data.recent.length > 0 && (
        <div style={{ marginTop: "1.25rem" }}>
          <h3>Recent calls</h3>
          <table className="history-table">
            <thead>
              <tr>
                <th>Bar (PKT)</th>
                <th>Pred</th>
                <th>Prob</th>
                <th>Conf</th>
                <th>Actual</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((r) => (
                <tr key={r.barTime}>
                  <td>{pkt(r.barTime)}</td>
                  <td className={r.predictedSide === "BUY" ? "side-buy" : "side-sell"}>
                    {r.predictedSide}
                  </td>
                  <td>{r.probabilityPct.toFixed(1)}%</td>
                  <td>{r.confidencePct}%</td>
                  <td>{r.actualSide ?? "…"}</td>
                  <td>
                    {r.correct == null ? "pending" : r.correct === 1 ? "HIT" : "MISS"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
