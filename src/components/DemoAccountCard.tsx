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
  sync?: {
    opened?: number;
    closed?: number;
    skipped?: number;
    errors?: string[];
  };
  dayBudget?: {
    pnlUsd: number;
    netR: number;
    stopR: number;
    lockR: number;
  } | null;
  regime?: { date: string; lines: string[] } | null;
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
            Auto-follow (default ON): Intraday · Intra30 · Cipher · QS Pro · Quick
            Scalp · Pro. Scalp / Fractal nahi. Worker har 60s History EXECUTED
            mirror karta hai — Demo tab khula hona zaroori nahi.
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
              <span>Live price</span>
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
            Auto-follow ON — Intraday · Intra30 · Cipher · QS Pro · Quick Scalp · Pro
            (Scalp / Fractal nahi). Sirf History pe EXECUTED locks.
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

          {data?.dayBudget && (
            <p className="demo-sync-status muted">
              Day desk {data.dayBudget.netR.toFixed(2)}R (lock {data.dayBudget.lockR}R
              / stop {data.dayBudget.stopR}R)
              {data.sync
                ? ` · last sync +${data.sync.opened ?? 0} open / ${data.sync.skipped ?? 0} skip`
                : ""}
              {" · "}
              follow needs module EXECUTED lock — aaj QS Pro empty ho to demo bhi empty.
            </p>
          )}

          <div className="demo-open-block">
            <div className="demo-open-head">
              <h3 className="demo-section demo-section-open">
                Open trades
                <span className="demo-open-count">
                  {data?.openPositions?.length ?? 0}
                </span>
              </h3>
              {(data?.floatingPnl != null && (data?.openPositions?.length ?? 0) > 0) && (
                <strong
                  className={`demo-open-total ${(data.floatingPnl ?? 0) >= 0 ? "demo-up" : "demo-down"}`}
                >
                  {money(data.floatingPnl)} float
                </strong>
              )}
            </div>
            {(data?.openPositions?.length ?? 0) === 0 ? (
              <p className="muted demo-open-empty">
                Koi open trade nahi. Main desk pe &quot;Demo pe trade lo&quot; dabao jab ENTER
                aaye.
              </p>
            ) : (
              <ul className="demo-open-list">
                {data!.openPositions!.map((p) => {
                  const float = p.floatingPnl ?? 0;
                  const floatUp = float >= 0;
                  return (
                    <li
                      key={p.id}
                      className={`demo-open-card ${p.side === "BUY" ? "is-buy" : "is-sell"}`}
                    >
                      <div className="demo-open-top">
                        <div className="demo-open-side">
                          <span className={`demo-side-pill ${p.side === "BUY" ? "buy" : "sell"}`}>
                            {p.side}
                          </span>
                          <div>
                            <strong className="demo-open-mod">{p.module}</strong>
                            <span className="demo-open-when">{pkt(p.openedAt)}</span>
                          </div>
                        </div>
                        <div className={`demo-open-pnl ${floatUp ? "demo-up" : "demo-down"}`}>
                          <span className="demo-open-pnl-main">{money(p.floatingPnl)}</span>
                          <span className="demo-open-pnl-r">
                            {p.floatingR != null ? `${p.floatingR.toFixed(2)}R` : "—"}
                          </span>
                        </div>
                      </div>
                      <div className="demo-open-levels">
                        <span>
                          Entry <b>{p.entry.toFixed(2)}</b>
                        </span>
                        <span>
                          SL <b>{p.sl.toFixed(2)}</b>
                        </span>
                        <span>
                          TP1 <b>{p.tp1.toFixed(2)}</b>
                        </span>
                        {p.tp2 != null && (
                          <span>
                            TP2 <b>{p.tp2.toFixed(2)}</b>
                          </span>
                        )}
                        <span>
                          Risk <b>${p.riskUsd.toFixed(2)}</b>
                        </span>
                      </div>
                      <div className="demo-row-actions">
                        <button
                          type="button"
                          className="demo-btn-tp"
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
                          className="demo-btn-sl"
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
                  );
                })}
              </ul>
            )}
          </div>

          <h3 className="demo-section">Recent closed</h3>
          <ul className="demo-list compact">
            {(data?.recentPositions ?? [])
              .filter(
                (p) =>
                  p.status === "CLOSED" &&
                  !p.note?.includes("VOID quote-spike"),
              )
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
