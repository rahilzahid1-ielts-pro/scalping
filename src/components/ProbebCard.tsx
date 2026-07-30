import { useEffect, useState } from "react";

type Side = "BUY" | "SELL";
type Quality = "strong" | "normal" | "weak";

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
    targetBarTime: number;
    quality: Quality;
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
    targetBarTime?: number;
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
    const t = setInterval(load, 12_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const live = data?.live;
  const today = data?.today;
  const wrongLifetime =
    (data?.lifetime.resolved ?? 0) - (data?.lifetime.correct ?? 0);
  const pending = (data?.recent ?? []).filter((r) => r.correct == null);
  const settled = (data?.recent ?? []).filter((r) => r.correct != null);

  return (
    <div className="card strategy-card probeb-card">
      <div className="card-head">
        <h2>Probeb</h2>
        <p className="muted">
          Har M5 close pe: upar agli candle predict · 5 min baad niche SAHI/GALAT
        </p>
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data?.waitReason && !live && (
        <p className="probeb-wait">{data.waitReason}</p>
      )}

      {live && (
        <div
          className={`probeb-hero ${live.side === "BUY" ? "buy" : "sell"}${
            live.quality === "strong" ? " strong" : ""
          }`}
        >
          <div className="probeb-hero-label">
            Agli candle kya banegi? · {pkt(live.targetBarTime)} PKT slot
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
              <span className="muted">Quality</span>
              <strong>{live.quality.toUpperCase()}</strong>
            </div>
          </div>
          <p className="probeb-strong-note">
            {live.quality === "strong"
              ? "STRONG — alert on (Push/Telegram agar enabled)."
              : live.quality === "normal"
                ? "Normal lean — 5 min baad result table mein SAHI/GALAT aayega."
                : "Weak lean (thin/edge) — phir bhi predict dikhaya; result track hoga."}
          </p>
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
            Strong: sahi {today.hiCorrect} · galat {today.hiWrong} ·{" "}
            {pct(today.hiAccuracyPct)}
            {" · "}
            Lifetime sahi {data?.lifetime.correct ?? 0} / galat {wrongLifetime} (
            {pct(data?.lifetime.accuracyPct)})
            {data?.walkAccuracy
              ? ` · Walk ${data.walkAccuracy.correct}/${data.walkAccuracy.resolved} (${pct(data.walkAccuracy.accuracyPct)})`
              : ""}
          </p>
        </div>
      )}

      {pending.length > 0 && (
        <div style={{ marginTop: "1.1rem" }}>
          <h3>Pending — agli candle close ka wait</h3>
          <table className="history-table">
            <thead>
              <tr>
                <th>Target M5</th>
                <th>Predict</th>
                <th>Win %</th>
                <th>Conf</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pending.slice(0, 6).map((r) => (
                <tr key={`p-${r.barTime}`}>
                  <td>{pkt(r.targetBarTime ?? r.barTime + 5 * 60 * 1000)}</td>
                  <td
                    className={
                      r.predictedSide === "BUY" ? "side-buy" : "side-sell"
                    }
                  >
                    {r.predictedSide}
                  </td>
                  <td>{r.probabilityPct.toFixed(1)}%</td>
                  <td>{r.confidencePct}%</td>
                  <td className="muted">waiting…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {settled.length > 0 && (
        <div style={{ marginTop: "1.25rem" }}>
          <h3>Result (5 min baad) — SAHI / GALAT</h3>
          <table className="history-table">
            <thead>
              <tr>
                <th>Target M5</th>
                <th>Predict</th>
                <th>Win %</th>
                <th>Actual</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {settled.slice(0, 20).map((r) => {
                const result = r.correct === 1 ? "SAHI" : "GALAT";
                return (
                  <tr key={`s-${r.barTime}`}>
                    <td>{pkt(r.targetBarTime ?? r.barTime + 5 * 60 * 1000)}</td>
                    <td
                      className={
                        r.predictedSide === "BUY" ? "side-buy" : "side-sell"
                      }
                    >
                      {r.predictedSide}
                    </td>
                    <td>{r.probabilityPct.toFixed(1)}%</td>
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
                        "—"
                      )}
                    </td>
                    <td>
                      <span
                        className={
                          result === "SAHI" ? "probeb-sahi" : "probeb-galat"
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
