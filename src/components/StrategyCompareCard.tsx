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
  } | null;
  latest: {
    direction: "BUY" | "SELL";
    entry: number;
    sl: number;
    tp1: number;
    tp2: number;
    reason: string;
    outcome: string;
    time: number;
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

interface Props {
  title: string;
  subtitle: string;
  apiPath: string;
  cacheKey: string;
  moduleLabel: string;
}

/**
 * Confirmed trade = worker lock only (OPEN / TP1 / SL).
 * Live preview is NOT an actionable trade — stops flip-flop "BUY then WAIT".
 */
export function StrategyCompareCard({
  title,
  subtitle,
  apiPath,
  cacheKey,
  moduleLabel,
}: Props) {
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
                time: j.latest.time,
                reason: j.latest.reason,
              }
            : null;
          const nextCache = syncCachedLock(cacheKey, fromServer);
          setCached(nextCache);

          const serverSnap = j.latest
            ? {
                side: j.latest.direction as "BUY" | "SELL",
                entry: j.latest.entry,
                sl: j.latest.sl,
                tp1: j.latest.tp1,
                outcome: j.latest.outcome,
                time: j.latest.time,
              }
            : null;
          const adv = syncExitAdvisory(
            cacheKey,
            moduleLabel,
            serverSnap,
            j.waitReason,
            Boolean((j as { historyOpen?: boolean }).historyOpen) ||
              serverSnap?.outcome === "OPEN",
          );
          setAdvisory(adv);
          if (adv) {
            // Cache cleared inside syncExitAdvisory — refresh display state
            setCached(syncCachedLock(cacheKey, fromServer));
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
  }, [apiPath, cacheKey, moduleLabel]);

  const locked = data?.latest ?? cached;
  const usingPhoneCache = !data?.latest && !!cached;
  const isConfirmed =
    !!locked &&
    (locked.outcome === "OPEN" ||
      locked.outcome === "TP1_HIT" ||
      locked.outcome === "SL_HIT" ||
      locked.outcome === "INVALIDATED");

  // Actionable hero = confirmed lock only (never live preview)
  const shown = isConfirmed
    ? {
        direction: locked!.direction,
        entry: locked!.entry,
        sl: locked!.sl,
        tp1: locked!.tp1,
        tp2: locked!.tp2,
        outcome: locked!.outcome,
        meta: usingPhoneCache
          ? `LOCKED (phone cache) · ${locked!.outcome} · ${new Date(locked!.time).toLocaleString()}`
          : `LOCKED · ${locked!.outcome} · ${new Date(locked!.time).toLocaleString()}`,
        reasons: parseReasons(locked!.reason ?? "[]"),
      }
    : null;

  const forming = !shown ? (data?.live ?? null) : null;

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
      <p className="action-now-label">{title}</p>
      <h2 className="action-now-headline">{headline}</h2>
      <p className="action-now-sub">{subtitle}</p>

      <ExitAdvisoryBanner
        advisory={advisory}
        onDismiss={() => setAdvisory(null)}
      />

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
          {data?.waitReason
            ? `Block: ${data.waitReason}`
            : "Confirmed lock ka wait — sirf worker lock pe trade lo (preview pe nahi)."}
        </p>
      )}

      {forming && (
        <div className="forming-preview">
          <strong>FORMING (lock nahi hua)</strong>
          <p>
            {forming.direction} setup dikh raha hai @ {forming.entry.toFixed(2)} — abhi entry
            mat lo. Jab LOCKED {forming.direction} aaye tab hi trade.
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
          <p className="action-now-detail">{shown.meta}</p>
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
