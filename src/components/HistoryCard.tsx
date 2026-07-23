import { useEffect, useMemo, useState } from "react";

type ModuleId =
  | "all"
  | "scalp"
  | "intraday"
  | "quick_scalp"
  | "qs_pro"
  | "pro"
  | "intra30"
  | "cipher_b"
  | "fractal";

type ExecutionFilter = "all" | "executed" | "not_executed";
type ResultFilter = "all" | "open" | "tp1" | "sl" | "invalidated";

interface HistoryTrade {
  id: string;
  module: string;
  moduleLabel: string;
  side: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number | null;
  outcome: string;
  outcomeLabel: string;
  realizedR: number | null;
  slMoney: number;
  tp1Money: number;
  tp2Money: number | null;
  pnlMoney: number | null;
  at: number;
  atKarachi: string;
  lockedAt: number;
  lockedAtKarachi: string;
  executed: boolean;
  executedAt: number | null;
  executedAtKarachi: string | null;
  executionLabel: "EXECUTED" | "NOT EXECUTED";
  resolvedAt: number | null;
  resolvedKarachi: string | null;
  description: string;
}

interface ModuleStats {
  module: string;
  moduleLabel: string;
  trades: number;
  open: number;
  wins: number;
  losses: number;
  other: number;
  winRate: number | null;
  avgR: number | null;
}

interface HistoryPayload {
  ok: boolean;
  date: string;
  from?: string;
  to?: string;
  timezone: string;
  moduleFilter: string;
  trades: HistoryTrade[];
  byModule: ModuleStats[];
  totals: ModuleStats;
  error?: string;
}

function karachiTodayInput(): string {
  const shift = 5 * 60 * 60 * 1000;
  const d = new Date(Date.now() + shift);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function px(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

function moneyCell(n: number | null | undefined, signed = true): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (!signed) return `$${Math.abs(n).toFixed(2)}`;
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function moneyClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "side-buy" : "side-sell";
}

function outcomeClass(outcome: string): string {
  if (outcome === "TP1_HIT" || outcome === "TP2_HIT") return "hist-out win";
  if (outcome === "SL_HIT") return "hist-out loss";
  if (outcome === "OPEN") return "hist-out open";
  return "hist-out other";
}

function execClass(label: string): string {
  return label === "EXECUTED" ? "hist-exec yes" : "hist-exec no";
}

function matchesResult(trade: HistoryTrade, filter: ResultFilter): boolean {
  if (filter === "all") return true;
  if (filter === "open") return trade.outcome === "OPEN";
  if (filter === "tp1") return trade.outcome === "TP1_HIT" || trade.outcome === "TP2_HIT";
  if (filter === "sl") return trade.outcome === "SL_HIT";
  return (
    trade.outcome === "INVALIDATED" ||
    trade.outcome === "REGIME_FLIP_INVALIDATED"
  );
}

function csvCell(value: string | number | null): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function historyCsv(trades: HistoryTrade[]): string {
  const headers = [
    "Start (PKT)",
    "Lock time (PKT)",
    "Execution status",
    "Executed at (PKT)",
    "Module",
    "Side",
    "Entry",
    "SL",
    "TP1",
    "TP2",
    "SL $",
    "TP1 $",
    "TP2 $",
    "P&L $",
    "Result",
    "R",
    "Resolved at (PKT)",
    "Description",
  ];
  const rows = trades.map((t) => [
    t.atKarachi,
    t.lockedAtKarachi,
    t.executionLabel,
    t.executedAtKarachi,
    t.moduleLabel,
    t.side,
    t.entry,
    t.sl,
    t.tp1,
    t.tp2,
    t.slMoney != null ? -Math.abs(t.slMoney) : "",
    t.tp1Money,
    t.tp2Money,
    t.pnlMoney,
    t.outcomeLabel,
    t.realizedR,
    t.resolvedKarachi,
    t.description,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

const MODULES: { id: ModuleId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "scalp", label: "Scalp" },
  { id: "intraday", label: "Intraday" },
  { id: "intra30", label: "Intra30" },
  { id: "quick_scalp", label: "Quick Scalp" },
  { id: "qs_pro", label: "QS Pro" },
  { id: "pro", label: "Pro" },
  { id: "cipher_b", label: "Cipher B" },
  { id: "fractal", label: "Fractal" },
];

export function HistoryCard() {
  const today = karachiTodayInput();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [module, setModule] = useState<ModuleId>("all");
  const [execution, setExecution] = useState<ExecutionFilter>("all");
  const [result, setResult] = useState<ResultFilter>("all");
  const [data, setData] = useState<HistoryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  const setFromSafe = (value: string) => {
    setFrom(value);
    if (value && to && value > to) setTo(value);
  };
  const setToSafe = (value: string) => {
    setTo(value);
    if (value && from && value < from) setFrom(value);
  };

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      setLoading(true);
      const q = new URLSearchParams({ from, to, module });
      void fetch(`/api/history?${q}`)
        .then(async (r) => {
          const j = (await r.json()) as HistoryPayload;
          if (!r.ok || j.ok === false) {
            throw new Error(j.error || `HTTP ${r.status}`);
          }
          return j;
        })
        .then((j) => {
          if (!cancelled) {
            setData(j);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : "fetch failed");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [from, to, module]);

  const totalsLine = useMemo(() => {
    const t = data?.totals;
    if (!t) return null;
    const wr = t.winRate == null ? "—" : `${t.winRate.toFixed(1)}%`;
    const ar = t.avgR == null ? "—" : `${t.avgR >= 0 ? "+" : ""}${t.avgR.toFixed(2)}R`;
    return `${t.trades} trades · ${t.wins}W / ${t.losses}L · ${t.open} open · WR ${wr} · avg ${ar}`;
  }, [data]);

  const visibleTrades = useMemo(() => {
    if (!data) return [];
    return data.trades.filter((trade) => {
      const executionMatch =
        execution === "all" ||
        (execution === "executed" ? trade.executed : !trade.executed);
      return executionMatch && matchesResult(trade, result);
    });
  }, [data, execution, result]);

  const downloadRange = async () => {
    setDownloading(true);
    try {
      const q = new URLSearchParams({ from, to, module: "all" });
      const response = await fetch(`/api/history?${q}`);
      const payload = (await response.json()) as HistoryPayload;
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      const blob = new Blob([`\uFEFF${historyCsv(payload.trades)}`], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const stamp = from === to ? from : `${from}_to_${to}`;
      anchor.download = `trade-history-${stamp}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "download failed");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section className="panel history-panel">
      <div className="panel-head">
        <h3>TRADE HISTORY</h3>
        <span className="badge">Asia/Karachi</span>
      </div>

      <div className="history-filters">
        <label className="history-field">
          <span>From</span>
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFromSafe(e.target.value)}
          />
        </label>
        <label className="history-field">
          <span>To</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setToSafe(e.target.value)}
          />
        </label>
        <div className="history-modules" role="tablist" aria-label="Module filter">
          {MODULES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={module === m.id ? "active" : ""}
              onClick={() => setModule(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <label className="history-field">
          <span>Execution</span>
          <select
            value={execution}
            onChange={(e) => setExecution(e.target.value as ExecutionFilter)}
          >
            <option value="all">All</option>
            <option value="executed">Executed only</option>
            <option value="not_executed">Not executed</option>
          </select>
        </label>
        <label className="history-field">
          <span>Result</span>
          <select
            value={result}
            onChange={(e) => setResult(e.target.value as ResultFilter)}
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="tp1">TP1 hit</option>
            <option value="sl">SL hit</option>
            <option value="invalidated">Invalidated</option>
          </select>
        </label>
        <button
          type="button"
          className="refresh-btn history-today"
          onClick={() => {
            const d = karachiTodayInput();
            setFrom(d);
            setTo(d);
          }}
        >
          Today
        </button>
        <button
          type="button"
          className="refresh-btn history-download"
          onClick={() => void downloadRange()}
          disabled={downloading}
          title="Selected date range ki tamam modules history CSV mein download karein"
        >
          {downloading ? "Downloading…" : "Download CSV"}
        </button>
      </div>

      {loading && !data && <p className="muted">Loading history…</p>}
      {error && <p className="history-error">{error}</p>}

      {data && (
        <>
          <div className="history-summary">
            <strong>{data.from && data.to ? (data.from === data.to ? data.from : `${data.from} → ${data.to}`) : data.date}</strong>
            <span>{totalsLine}</span>
            {visibleTrades.length !== data.trades.length && (
              <span>
                Showing {visibleTrades.length} of {data.trades.length}
              </span>
            )}
          </div>

          {data.byModule.length > 0 && (
            <div className="history-module-stats">
              {data.byModule.map((s) => (
                <div key={s.module} className="history-stat-chip">
                  <strong>{s.moduleLabel}</strong>
                  <span>
                    {s.trades} · {s.wins}W/{s.losses}L
                    {s.winRate != null ? ` · ${s.winRate.toFixed(0)}%` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {visibleTrades.length === 0 ? (
            <p className="muted">
              {data.trades.length === 0
                ? "Is range me koi trade nahi — lock dikhega as NOT EXECUTED; jab price entry pe aaye to EXECUTED time ke sath."
                : "Selected filters ke liye koi trade nahi."}
            </p>
          ) : (
            <div className="history-table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Start (PKT)</th>
                    <th>Status</th>
                    <th>Module</th>
                    <th>Side</th>
                    <th>Entry</th>
                    <th>SL</th>
                    <th>TP1</th>
                    <th>SL $</th>
                    <th>TP1 $</th>
                    <th>P&amp;L $</th>
                    <th>Result</th>
                    <th>R</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTrades.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <div>{t.atKarachi}</div>
                        {!t.executed && (
                          <div className="history-lock-hint">lock {t.lockedAtKarachi}</div>
                        )}
                      </td>
                      <td>
                        <span className={execClass(t.executionLabel)}>
                          {t.executionLabel}
                        </span>
                      </td>
                      <td>{t.moduleLabel}</td>
                      <td className={t.side === "BUY" ? "side-buy" : "side-sell"}>
                        {t.side}
                      </td>
                      <td>{px(t.entry)}</td>
                      <td>{px(t.sl)}</td>
                      <td>{px(t.tp1)}</td>
                      <td className="side-sell" title="Risk to stop (per oz)">
                        {moneyCell(t.slMoney != null ? -Math.abs(t.slMoney) : null)}
                      </td>
                      <td className="side-buy" title="Reward to TP1 (per oz)">
                        {moneyCell(t.tp1Money)}
                      </td>
                      <td className={moneyClass(t.pnlMoney)} title="Realized P&L when closed">
                        {moneyCell(t.pnlMoney)}
                      </td>
                      <td>
                        <span className={outcomeClass(t.outcome)}>{t.outcomeLabel}</span>
                      </td>
                      <td>
                        {t.realizedR == null
                          ? "—"
                          : `${t.realizedR >= 0 ? "+" : ""}${t.realizedR.toFixed(2)}`}
                      </td>
                      <td className="history-desc">{t.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
