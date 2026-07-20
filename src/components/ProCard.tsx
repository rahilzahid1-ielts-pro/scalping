import { useEffect, useState } from "react";
import { syncCachedLock, type CachedLock } from "../services/lockCache";
import { syncExitAdvisory, type ExitAdvisory } from "../services/exitAdvisory";
import { ExitAdvisoryBanner } from "./ExitAdvisoryBanner";

interface LatestPayload {
  ok: boolean;
  validated: boolean;
  badge: string | null;
  waitReason?: string | null;
  live?: {
    direction: "BUY" | "SELL";
    entry: number;
    sl: number;
    tp1: number;
    tp2: number;
    confidence: number;
    regime: string;
    dailyBias: string;
  } | null;
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

function useLockedModule(
  apiPath: string,
  cacheKey: string,
  moduleLabel: string,
) {
  const [data, setData] = useState<LatestPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cached, setCached] = useState<CachedLock | null>(() =>
    syncCachedLock(cacheKey, null),
  );
  const [advisory, setAdvisory] = useState<ExitAdvisory | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetch(apiPath)
        .then((r) => r.json())
        .then((j: LatestPayload) => {
          if (cancelled) return;
          setData(j);
          setError(null);
          const fromServer: CachedLock | null = j.latest
            ? {
                direction: j.latest.direction,
                entry: j.latest.entry,
                sl: j.latest.sl,
                tp1: j.latest.tp1,
                tp2: j.latest.tp2,
                outcome: j.latest.outcome,
                time: j.latest.timestamp,
                reason: j.latest.reason,
                metaExtra: { dailyBias: j.latest.dailyBias },
              }
            : null;
          setCached(syncCachedLock(cacheKey, fromServer));
          const adv = syncExitAdvisory(
            cacheKey,
            moduleLabel,
            j.latest
              ? {
                  side: j.latest.direction,
                  entry: j.latest.entry,
                  sl: j.latest.sl,
                  tp1: j.latest.tp1,
                  outcome: j.latest.outcome,
                  time: j.latest.timestamp,
                }
              : null,
            j.waitReason,
            Boolean((j as { historyOpen?: boolean }).historyOpen) ||
              j.latest?.outcome === "OPEN",
          );
          setAdvisory(adv);
          if (adv) setCached(syncCachedLock(cacheKey, fromServer));
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
  }, [apiPath, cacheKey, moduleLabel]);

  const locked = data?.latest
    ? data.latest
    : cached
      ? {
          direction: cached.direction,
          entry: cached.entry,
          sl: cached.sl,
          tp1: cached.tp1,
          tp2: cached.tp2,
          confidence: 0,
          regime: "",
          dailyBias: String(cached.metaExtra?.dailyBias ?? "—"),
          reason: cached.reason ?? "[]",
          outcome: cached.outcome,
          timestamp: cached.time,
        }
      : null;

  const usingPhoneCache = !data?.latest && !!cached;
  const isConfirmed =
    !!locked &&
    (locked.outcome === "OPEN" ||
      locked.outcome === "TP1_HIT" ||
      locked.outcome === "SL_HIT" ||
      locked.outcome === "INVALIDATED");

  const shown = isConfirmed
    ? {
        direction: locked!.direction,
        entry: locked!.entry,
        sl: locked!.sl,
        tp1: locked!.tp1,
        tp2: locked!.tp2,
        dailyBias: locked!.dailyBias,
        outcome: locked!.outcome,
        meta: usingPhoneCache
          ? `LOCKED (phone cache) · ${locked!.outcome}`
          : `LOCKED · ${locked!.outcome} · ${new Date(locked!.timestamp).toLocaleString()}`,
        reasons: parseReasons(locked!.reason),
      }
    : null;

  return {
    data,
    error,
    advisory,
    setAdvisory,
    shown,
    forming: !shown ? (data?.live ?? null) : null,
  };
}

function ModuleCardShell(props: {
  label: string;
  subtitle: string;
  apiPath: string;
  cacheKey: string;
  moduleLabel: string;
  emptyHint: string;
}) {
  const { data, error, advisory, setAdvisory, shown, forming } = useLockedModule(
    props.apiPath,
    props.cacheKey,
    props.moduleLabel,
  );

  const tone =
    shown?.direction === "BUY"
      ? "enter-buy"
      : shown?.direction === "SELL"
        ? "enter-sell"
        : "wait";
  const headline = shown
    ? shown.outcome === "OPEN"
      ? shown.direction
      : `${shown.direction} · ${shown.outcome.replace("_", " ")}`
    : "WAITING";

  return (
    <section className={`action-now tone-${tone}`}>
      <p className="action-now-label">{props.label}</p>
      <h2 className="action-now-headline">{headline}</h2>
      <p className="action-now-sub">{props.subtitle}</p>

      <ExitAdvisoryBanner advisory={advisory} onDismiss={() => setAdvisory(null)} />

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

      {!shown && !error && (
        <p className="action-now-detail">
          {data?.waitReason ? `Block: ${data.waitReason}` : props.emptyHint}
        </p>
      )}

      {forming && (
        <div className="forming-preview">
          <strong>FORMING (lock nahi hua)</strong>
          <p>
            {forming.direction} @ {forming.entry.toFixed(2)} · conf {forming.confidence}% —
            abhi entry mat lo. Sirf LOCKED pe trade.
          </p>
        </div>
      )}

      {shown && (
        <>
          <div className="action-now-levels">
            <div>
              <span>Entry</span>
              <strong>{shown.entry.toFixed(2)}</strong>
            </div>
            <div>
              <span>SL</span>
              <strong className="sl">{shown.sl.toFixed(2)}</strong>
            </div>
            <div>
              <span>TP1</span>
              <strong className="tp">{shown.tp1.toFixed(2)}</strong>
            </div>
            <div>
              <span>TP2</span>
              <strong className="tp">{shown.tp2.toFixed(2)}</strong>
            </div>
          </div>
          <p className="action-now-detail">
            Daily: {shown.dailyBias} · {shown.meta}
          </p>
          {shown.reasons.length > 0 && (
            <ul className="rationale">
              {shown.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function ProCard() {
  return (
    <ModuleCardShell
      label="PRO · Gold"
      subtitle="Strict SMC — conf≥80 · HTF aligned · trend only · daily bias agrees"
      apiPath="/api/pro/latest"
      cacheKey="pro"
      moduleLabel="Pro"
      emptyHint="Confirmed LOCK ka wait — preview pe trade mat lo."
    />
  );
}
