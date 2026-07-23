import { useCallback, useEffect, useState } from "react";

interface DemoAccount {
  id: string;
  name: string;
  balance: number;
  startingBalance: number;
  riskPct: number;
  autoFollow: boolean;
}

interface DemoPosition {
  id: string;
  module: string;
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number | null;
  riskUsd: number;
  status: "OPEN" | "CLOSED";
  outcome: string;
  realizedR: number | null;
  pnlUsd: number | null;
  openedAt: number;
  closedAt: number | null;
  note: string;
  floatingR?: number | null;
  floatingPnl?: number | null;
}

interface DemoLedger {
  id: string;
  kind: string;
  amount: number;
  balanceAfter: number;
  note: string;
  at: number;
}

interface DemoPayload {
  ok: boolean;
  account?: DemoAccount;
  equity?: number;
  floatingPnl?: number;
  dayPnl?: number;
  livePrice?: number | null;
  openPositions?: DemoPosition[];
  recentPositions?: DemoPosition[];
  ledger?: DemoLedger[];
  error?: string;
}

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

function pkt(ms: number): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Karachi",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
      hour12: true,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

export function DemoAccountCard() {
  const [data, setData] = useState<DemoPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/demo/account");
      const j = (await res.json()) as DemoPayload;
      if (!j.ok) throw new Error(j.error || "demo load failed");
      setData(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Demo load failed");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  async function post(path: string, body?: unknown) {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body != null ? JSON.stringify(body) : undefined,
      });
      const j = (await res.json()) as { ok: boolean; error?: string };
      if (!j.ok) throw new Error(j.error || "request failed");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  const acct = data?.account;
  const balClass =
    (data?.dayPnl ?? 0) > 0 ? "demo-up" : (data?.dayPnl ?? 0) < 0 ? "demo-down" : "";

  return (
    <section className="panel demo-account">
      <header className="demo-head">
        <div>
          <p className="demo-kicker">PAPER / DEMO</p>
          <h2>Demo Account</h2>
          <p className="demo-sub">
            Auto trades (default ON): Intraday · Intra30 · Cipher · QS Pro · Quick Scalp ·
            Fractal. Main Scalp kabhi nahi. Risk balance se, P&amp;L add/minus.
          </p>
        </div>
        <button
          type="button"
          className="demo-reset"
          disabled={busy}
          onClick={() => {
            if (window.confirm("Balance $2000 pe reset + saari demo trades clear?")) {
              void post("/api/demo/reset");
            }
          }}
        >
          Reset $2000
        </button>
      </header>

      {error && <p className="demo-error">{error}</p>}

      {!acct ? (
        <p className="muted">Loading demo account…</p>
      ) : (
        <>
          <div className="demo-stats">
            <div>
              <span>Balance</span>
              <strong>${acct.balance.toFixed(2)}</strong>
            </div>
            <div>
              <span>Equity</span>
              <strong>${(data?.equity ?? acct.balance).toFixed(2)}</strong>
            </div>
            <div>
              <span>Floating</span>
              <strong className={(data?.floatingPnl ?? 0) >= 0 ? "demo-up" : "demo-down"}>
                {money(data?.floatingPnl)}
              </strong>
            </div>
            <div>
              <span>Day P&amp;L</span>
              <strong className={balClass}>{money(data?.dayPnl)}</strong>
            </div>
            <div>
              <span>Risk / trade</span>
              <strong>{acct.riskPct}%</strong>
            </div>
            <div>
              <span>Live Gold</span>
              <strong>
                {data?.livePrice != null ? data.livePrice.toFixed(2) : "—"}
              </strong>
            </div>
          </div>

          <div className="demo-controls">
            <label className="demo-toggle">
              <input
                type="checkbox"
                checked={acct.autoFollow}
                disabled={busy}
                onChange={(e) =>
                  void post("/api/demo/settings", { autoFollow: e.target.checked })
                }
              />
              Auto-follow ON — Intraday · Intra30 · Cipher · QS Pro · Quick Scalp · Fractal (Scalp nahi)
            </label>
            <label className="demo-risk">
              Risk %
              <select
                value={acct.riskPct}
                disabled={busy}
                onChange={(e) =>
                  void post("/api/demo/settings", { riskPct: Number(e.target.value) })
                }
              >
                {[0.5, 1, 1.5, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}%
                  </option>
                ))}
              </select>
            </label>
          </div>

          <h3 className="demo-section">OPEN positions</h3>
          {(data?.openPositions?.length ?? 0) === 0 ? (
            <p className="muted">
              Koi open trade nahi. Main desk pe &quot;Demo pe trade lo&quot; dabao jab ENTER
              aaye.
            </p>
          ) : (
            <ul className="demo-list">
              {data!.openPositions!.map((p) => (
                <li key={p.id}>
                  <div className="demo-row-main">
                    <strong className={p.side === "BUY" ? "demo-up" : "demo-down"}>
                      {p.side}
                    </strong>
                    <span>
                      {p.module} · @{p.entry.toFixed(2)} · SL {p.sl.toFixed(2)} · TP1{" "}
                      {p.tp1.toFixed(2)}
                    </span>
                  </div>
                  <div className="demo-row-meta">
                    Risk ${p.riskUsd.toFixed(2)} · Float {money(p.floatingPnl)} (
                    {p.floatingR != null ? `${p.floatingR.toFixed(2)}R` : "—"}) ·{" "}
                    {pkt(p.openedAt)}
                  </div>
                  <div className="demo-row-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void post("/api/demo/close", {
                          positionId: p.id,
                          outcome: "TP1_HIT",
                        })
                      }
                    >
                      Close TP1
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void post("/api/demo/close", {
                          positionId: p.id,
                          outcome: "SL_HIT",
                        })
                      }
                    >
                      Close SL
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void post("/api/demo/close", {
                          positionId: p.id,
                          outcome: "MANUAL",
                          realizedR: 0,
                        })
                      }
                    >
                      Flat 0R
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h3 className="demo-section">Recent closed</h3>
          <ul className="demo-list compact">
            {(data?.recentPositions ?? [])
              .filter((p) => p.status === "CLOSED")
              .slice(0, 12)
              .map((p) => (
                <li key={p.id}>
                  <strong className={p.side === "BUY" ? "demo-up" : "demo-down"}>
                    {p.side}
                  </strong>{" "}
                  {p.module} · {p.outcome} ·{" "}
                  <span className={(p.pnlUsd ?? 0) >= 0 ? "demo-up" : "demo-down"}>
                    {money(p.pnlUsd)}
                  </span>
                  {p.realizedR != null ? ` (${p.realizedR.toFixed(2)}R)` : ""} ·{" "}
                  {p.closedAt ? pkt(p.closedAt) : ""}
                </li>
              ))}
          </ul>

          <h3 className="demo-section">Ledger</h3>
          <ul className="demo-list compact">
            {(data?.ledger ?? []).slice(0, 15).map((l) => (
              <li key={l.id}>
                {l.kind} ·{" "}
                <span className={l.amount >= 0 ? "demo-up" : "demo-down"}>
                  {money(l.amount)}
                </span>{" "}
                → bal ${l.balanceAfter.toFixed(2)} · {pkt(l.at)}
                {l.note ? ` — ${l.note}` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
