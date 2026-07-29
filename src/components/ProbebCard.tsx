import { useEffect, useState } from "react";

type Side = "BUY" | "SELL";

interface DayAcc {
  dayKey: string;
  resolved: number;
  correct: number;
  wrong: number;
  accuracyPct: number | null;
  hiResolved: number;
  hiCorrect: number;
  hiWrong: number;
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
    return new Date(ms).toLocaleString("en-GB", {
      timeZone: "Asia/Karachi",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
    });
  } catch {
    return String(ms);
  }
}

function isStrong(prob: number, conf: number): boolean {
  return prob >= 60 && conf >= 40;
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
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const live = data?.live;
  const today = data?.today;
  const strong = live ? isStrong(live.probabilityPct, live.confidencePct) : false;
  const wrongLifetime =
    (data?.lifetime.resolved ?? 0) - (data?.lifetime.correct ?? 0);

  return (
    <div className="card strategy-card probeb-card">
      <div className="card-head">
        <h2>Probeb</h2>
        <p className="muted">
          Har band M5 ke baad: agli candle BUY ya SELL? Winning % · confidence ·
          aaj sahi/galat
        </p>
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data?.waitReason && !live && <p className="muted">{data.waitReason}</p>}

      {live && (
        <div
          className={`probeb-hero ${live.side === "BUY" ? "buy" : "sell"}${strong ? " strong" : ""}`}
        >
          <div className="probeb-hero-label">
            {strong ? "STRONG — agli M5 candle" : "Agli M5 candle lean"}
          </div>
          <div className="probeb-hero-side">{live.side}</div>
          <div className="probeb-hero-metrics">
            <div>
              <span className="muted">Winning %</span>
              <strong>{live.probabilityPct.toFixed(1)}%</strong>
            </div>
            <div>
              <span className="muted">Confidence</span>
              <strong>{live.confidencePct}%</strong>
            </div>
            <div>
              <span className="muted">Sample</span>
              <strong>n={live.sampleN}</strong>
            </div>
          </div>
          {strong && (
            <p className="probeb-strong-note">
              Strong call — alert bhi jayega (Push/Telegram agar on ho).
            </p>
          )}
        </div>
      )}

      {today && (
        <div className="probeb-day">
          <h3>Aaj ({today.dayKey})</h3>
          <div className="probeb-day-grid">
            <div className="probeb-day-cell sahi">
              <span className="muted">Sahi</span>
              <strong>{today.correct}</strong>
            </div>
            <div className="probeb-day-cell galat">
              <span className="muted">Galat</span>
              <strong>{today.wrong}</strong>
            </div>
            <div className="probeb-day-cell">
              <span className="muted">Total</span>
              <strong>{today.resolved}</strong>
            </div>
            <div className="probeb-day-cell pct">
              <span className="muted">Winning %</span>
              <strong>{pct(today.accuracyPct)}</strong>
            </div>
          </div>
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            Strong calls (conf≥40): sahi {today.hiCorrect} · galat {today.hiWrong}{" "}
            · {pct(today.hiAccuracyPct)}
            {" · "}
            Lifetime sahi {data?.lifetime.correct ?? 0} / galat {wrongLifetime} (
            {pct(data?.lifetime.accuracyPct)})
            {data?.walkAccuracy
              ? ` · Walk ${data.walkAccuracy.correct}/${data.walkAccuracy.resolved} (${pct(data.walkAccuracy.accuracyPct)})`
              : ""}
          </p>
        </div>
      )}

      {data?.recent && data.recent.length > 0 && (
        <div style={{ marginTop: "1.25rem" }}>
          <h3>Har 5 min — result</h3>
          <table className="history-table">
            <thead>
              <tr>
                <th>M5 (PKT)</th>
                <th>Predict</th>
                <th>Win %</th>
                <th>Conf</th>
                <th>Actual</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((r) => {
                const result =
                  r.correct == null
                    ? "pending"
                    : r.correct === 1
                      ? "SAHI"
                      : "GALAT";
                return (
                  <tr key={r.barTime}>
                    <td>{pkt(r.barTime)}</td>
                    <td
                      className={
                        r.predictedSide === "BUY" ? "side-buy" : "side-sell"
                      }
                    >
                      {r.predictedSide}
                    </td>
                    <td>{r.probabilityPct.toFixed(1)}%</td>
                    <td>{r.confidencePct}%</td>
                    <td>
                      {r.actualSide ? (
                        <span
                          className={
                            r.actualSide === "BUY" ? "side-buy" : "side-sell"
                          }
                        >
                          {r.actualSide}
                        </span>
                      ) : (
                        "…"
                      )}
                    </td>
                    <td>
                      <span
                        className={
                          result === "SAHI"
                            ? "probeb-sahi"
                            : result === "GALAT"
                              ? "probeb-galat"
                              : "muted"
                        }
                      >
                        {result}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
