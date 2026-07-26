import { useCallback, useEffect, useState } from "react";

type ModuleRow = {
  module: string;
  tier: string;
  confidencePct: number | null;
  allowNewLock: boolean;
  wins: number;
  losses: number;
  executed: number;
};

type LearnStatus = {
  ok: boolean;
  running?: boolean;
  model?: {
    loaded: boolean;
    trainedAt: string | null;
    sampleN: number;
    wr: number | null;
    playbookN: number;
    source: string | null;
    gateActive: boolean;
  };
  weekly?: {
    enabled: boolean;
    state: "off" | "ok" | "never" | "stale";
    lastRunIso: string | null;
    lastOk: boolean | null;
    lastSampleN: number | null;
    lastWr: number | null;
    liveAdded: number | null;
    daysSince: number | null;
    nextHint: string;
  };
  labels?: { jsonl: boolean; gz: boolean; playbookFile: boolean };
  day?: { date: string; modules: ModuleRow[] } | null;
  error?: string;
};

function pkt(isoOrMs: string | number | null | undefined): string {
  if (isoOrMs == null) return "—";
  const ms = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ms)) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Karachi",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function stateLabel(s: LearnStatus["weekly"]): string {
  if (!s) return "—";
  if (s.state === "off") return "OFF";
  if (s.state === "never") return "ON · waiting first Sunday run";
  if (s.state === "stale") return "ON · run overdue / check logs";
  if (s.state === "ok") return "ON · healthy";
  return "ON";
}

function confClass(c: number | null): string {
  if (c == null) return "learn-conf pending";
  if (c >= 70) return "learn-conf hot";
  if (c < 60) return "learn-conf cold";
  return "learn-conf mid";
}

export function LearnStatusCard() {
  const [data, setData] = useState<LearnStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/learn/status");
      const j = (await res.json()) as LearnStatus;
      if (!j.ok) throw new Error(j.error || "learn status failed");
      setData(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Learn status failed");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const model = data?.model;
  const weekly = data?.weekly;
  const live = Boolean(model?.loaded && model?.gateActive);
  const modules = (data?.day?.modules ?? [])
    .filter((m) => m.executed > 0 || m.module === "qs_pro" || m.module === "cipher_b" || m.module === "pro")
    .slice()
    .sort((a, b) => (b.confidencePct ?? -1) - (a.confidencePct ?? -1));

  return (
    <section className="panel learn-status-panel" aria-label="ML learn status">
      <div className="learn-status-head">
        <h3>ML / Learn</h3>
        <span className={live ? "learn-badge on" : "learn-badge off"}>
          {live ? "LIVE GATE ON" : "MODEL MISSING"}
        </span>
      </div>

      {error && <p className="learn-err">{error}</p>}

      {!data && !error && <p className="muted">Loading learn status…</p>}

      {data && (
        <>
          <div className="learn-grid">
            <div>
              <div className="learn-k">Model</div>
              <div className="learn-v">
                {model?.loaded
                  ? `${model.sampleN.toLocaleString()} trades · WR ${model.wr ?? "—"}%`
                  : "Not loaded"}
              </div>
              <div className="learn-sub">
                Trained {pkt(model?.trainedAt)} · playbook {model?.playbookN ?? 0}
                {model?.source ? ` · ${model.source}` : ""}
              </div>
            </div>
            <div>
              <div className="learn-k">Weekly retrain</div>
              <div className="learn-v">{stateLabel(weekly)}</div>
              <div className="learn-sub">
                Last {pkt(weekly?.lastRunIso)}
                {weekly?.lastWr != null ? ` · WR ${weekly.lastWr}%` : ""}
                {weekly?.liveAdded != null ? ` · +${weekly.liveAdded} live` : ""}
                {weekly?.daysSince != null ? ` · ${weekly.daysSince}d ago` : ""}
                {" · "}
                {weekly?.nextHint}
              </div>
            </div>
            <div>
              <div className="learn-k">Labels on disk</div>
              <div className="learn-v">
                {data.labels?.gz ? "gz ✓" : "gz —"}
                {" · "}
                {data.labels?.jsonl ? "jsonl ✓" : "jsonl —"}
              </div>
              <div className="learn-sub">
                Gate blocks bad playbook / low day confidence / Friday close
              </div>
            </div>
          </div>

          {modules.length > 0 && (
            <div className="learn-mods">
              <div className="learn-k">Today confidence (PKT {data.day?.date})</div>
              <div className="learn-mod-row">
                {modules.map((m) => (
                  <span key={m.module} className={confClass(m.confidencePct)} title={m.tier}>
                    {m.module.replace("_", " ")}{" "}
                    {m.confidencePct != null ? `${m.confidencePct}%` : "…"}
                    {!m.allowNewLock ? " ⏸" : ""}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
