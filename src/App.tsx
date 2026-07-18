import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ASSET_LIST, ASSETS } from "./config/assets";
import { fetchMultiTimeframe } from "./services/marketData";
import { computeRegime, generateSignal } from "./strategies/signalEngine";
import type { AssetId, LiveSignal, TradeMode } from "./types";
import { TradingViewChart } from "./components/TradingViewChart";
import { ActionNow } from "./components/ActionNow";
import { DetailsAccordion } from "./components/DetailsAccordion";
import { BiasCard } from "./components/BiasCard";
import { PredictionPanel } from "./components/PredictionPanel";
import { StrategyBreakdown } from "./components/StrategyBreakdown";
import { useLivePrice } from "./hooks/useLivePrice";
import { requestAlertPermission, testAlertSound, useEntryAlert, usePlanLockAlert } from "./hooks/useEntryAlert";
import { useServiceWorkerAlerts } from "./hooks/useServiceWorkerAlerts";
import { BackgroundAlertBanner } from "./components/BackgroundAlertBanner";
import { roundPrice } from "./strategies/indicators";
import { computeNowAction } from "./utils/nowAction";
import {
  buildSessionExtras,
  canAutoLockPlan,
  signalInterval,
} from "./utils/sessionPlan";
import {
  createFrozenPlan,
  ensureLockedScores,
  loadSession,
  saveSession,
  shouldKeepFrozenPlan,
  REGIME_FLIP_NOTE,
  type FrozenPlan,
} from "./services/tradePlan";
import {
  logSignalViaApi,
  regimeFlipInvalidateViaApi,
  resolveSignalsViaApi,
} from "./calibration/browserClient";
import { CONFLICT_CAP_PCT } from "./calibration/types";

const boot = loadSession();

export default function App() {
  const [assetId, setAssetId] = useState<AssetId>(boot.assetId);
  const [mode, setMode] = useState<TradeMode>(boot.mode);
  const [signal, setSignal] = useState<LiveSignal | null>(null);
  const [plan, setPlan] = useState<FrozenPlan | null>(boot.plan);
  const [forceNewPlan, setForceNewPlan] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [alertsOn, setAlertsOn] = useState(boot.alertsOn);
  const [now, setNow] = useState(Date.now());
  const [booted, setBooted] = useState(false);

  const { quote, error: quoteError, pollMs } = useLivePrice(assetId);
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  const planRef = useRef(plan);
  planRef.current = plan;
  const skipClearRef = useRef(true);

  const asset = ASSETS[assetId];
  const hasActivePlan =
    !!plan &&
    plan.assetId === assetId &&
    plan.mode === mode &&
    plan.status !== "INVALIDATED";
  const refreshMs = signalInterval(mode, hasActivePlan);

  useEffect(() => {
    saveSession({ assetId, mode, plan, alertsOn });
  }, [assetId, mode, plan, alertsOn]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const livePx = quoteRef.current?.price;
      const frames = await fetchMultiTimeframe(assetId, mode, livePx);
      const next = generateSignal(assetId, mode, frames);
      const q = quoteRef.current?.price;
      if (q != null) next.price = roundPrice(q, asset.decimals);

      const current = planRef.current;

      // HARD RULE: if locked plan exists for this pair+mode — NEVER change entry/SL/TP
      if (
        current &&
        current.assetId === assetId &&
        current.mode === mode &&
        current.status !== "INVALIDATED" &&
        (current.side === "BUY" || current.side === "SELL")
      ) {
        // Never backfill locked scores from a later WAIT (confidence hard-capped ≤58).
        const scoredPlan =
          current.lockedConfidence == null &&
          next.side === current.side &&
          next.confidence >= 68
            ? ensureLockedScores(
                current,
                next.confidence,
                next.rangePrediction.winProbability,
              )
            : current;
        const htfRegimes = [
          frames.confirmation.length ? computeRegime(frames.confirmation) : null,
          frames.bias.length ? computeRegime(frames.bias) : null,
        ];
        const kept = shouldKeepFrozenPlan(
          scoredPlan,
          next.side,
          q,
          next.diagnostics.regime,
          htfRegimes,
        );
        // Regime flip: trend reversed vs plan side. Drop plan (allow immediate
        // re-lock next refresh) and log it; no entry/resolution alert.
        if (kept && kept.status === "INVALIDATED" && kept.note === REGIME_FLIP_NOTE) {
          setPlan(null);
          planRef.current = null;
          void regimeFlipInvalidateViaApi(current);
        } else if (kept) {
          setPlan(kept);
          next.levels = kept.levels;
          next.side = kept.side;
          // Keep the scores the user saw when this plan locked — do not let a
          // later WAIT refresh (confidence capped at 58) rewrite the card.
          if (kept.lockedConfidence != null) {
            next.confidence = kept.lockedConfidence;
          }
          if (kept.lockedWinProbability != null) {
            next.rangePrediction = {
              ...next.rangePrediction,
              winProbability: kept.lockedWinProbability,
            };
          }
          // Conflict refresh must not leave locked scores above the cap while
          // diagnostics still show the ≤65% warning.
          if (next.diagnostics.conflictCapped || next.diagnostics.conflictingSignals) {
            next.confidence = Math.min(next.confidence, CONFLICT_CAP_PCT);
            next.rangePrediction = {
              ...next.rangePrediction,
              confidence: Math.min(next.rangePrediction.confidence, CONFLICT_CAP_PCT),
              winProbability: Math.min(
                next.rangePrediction.winProbability,
                CONFLICT_CAP_PCT,
              ),
            };
          }
          void logSignalViaApi(next);
        }
      } else if (
        (!current || current.status === "INVALIDATED" || current.assetId !== assetId || current.mode !== mode) &&
        canAutoLockPlan(mode, next, current, assetId)
      ) {
        if (!current || current.status === "INVALIDATED" || current.assetId !== assetId || current.mode !== mode) {
          const extras = buildSessionExtras(assetId, mode, next.side, next.levels!, next);
          setPlan(
            createFrozenPlan(
              assetId,
              mode,
              next.side,
              next.levels!,
              next.confidence,
              next.rangePrediction.winProbability,
              extras,
            ),
          );
          void logSignalViaApi(next);
        }
      }

      setSignal(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load market data");
    } finally {
      setLoading(false);
      setBooted(true);
    }
  }, [assetId, mode, asset.decimals]);

  useEffect(() => {
    if (skipClearRef.current) {
      skipClearRef.current = false;
    } else {
      // User switched Gold/Silver/BTC or Scalp/Intraday — new plan allowed
      setPlan(null);
      setSignal(null);
      setLoading(true);
    }
    void refresh();
  }, [assetId, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = window.setInterval(() => void refresh(), refreshMs);
    return () => window.clearInterval(id);
  }, [refreshMs, refresh]);

  useEffect(() => {
    if (forceNewPlan === 0) return;
    setPlan(null);
    planRef.current = null;
    saveSession({ assetId, mode, plan: null, alertsOn });
    void refresh();
  }, [forceNewPlan]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 300);
    return () => window.clearInterval(id);
  }, []);

  // Soft SL check only — do NOT rewrite entry
  useEffect(() => {
    const current = planRef.current;
    if (!current || !quote?.price || current.status === "INVALIDATED") return;
    void resolveSignalsViaApi(assetId, quote.price, {
      high: quote.high,
      low: quote.low,
      open: quote.price,
    });
    if (current.side === "SELL" && quote.price >= current.levels.stopLoss) {
      setPlan({
        ...current,
        status: "INVALIDATED",
        note: "SL hit on live price.",
      });
    } else if (current.side === "BUY" && quote.price <= current.levels.stopLoss) {
      setPlan({
        ...current,
        status: "INVALIDATED",
        note: "SL hit on live price.",
      });
    }
  }, [quote?.price, quote?.high, quote?.low, assetId]);

  const livePrice = quote?.price ?? signal?.price ?? 0;

  const nowAction = useMemo(() => {
    if (!signal || !livePrice) return null;
    return computeNowAction(signal, plan, livePrice, asset, quote);
  }, [signal, plan, livePrice, asset, quote]);

  // Once the app instructed ENTER NOW, persist an active-trade state. From this
  // point a refresh/New plan must not turn that instruction into WAIT/opposite.
  useEffect(() => {
    if (nowAction?.action !== "ENTER_NOW") return;
    setPlan((current) => {
      if (!current || current.status !== "WAITING_ENTRY") return current;
      const active: FrozenPlan = {
        ...current,
        status: "IN_TRADE_HINT",
        note: `Entry hit @ ${current.levels.entry}. Trade active; manage original SL/TP.`,
      };
      planRef.current = active;
      return active;
    });
  }, [nowAction?.action]);

  // Key ONLY on locked entry — refresh must not reset alert arming wrongly
  const planKey = plan
    ? `${plan.assetId}-${plan.mode}-${plan.side}-${plan.levels.entry}-${plan.lockedAt}`
    : "none";

  usePlanLockAlert(plan?.status !== "INVALIDATED" ? plan : null, alertsOn);
  useEntryAlert({ now: nowAction, enabled: alertsOn, planKey });
  useServiceWorkerAlerts(nowAction, alertsOn, planKey, plan);

  const toggleAlerts = async () => {
    await requestAlertPermission();
    setAlertsOn((a) => !a);
  };

  const requestNewPlan = () => {
    const current = planRef.current;
    if (current?.status === "IN_TRADE_HINT") {
      window.alert(
        `${current.side} trade @ ${current.levels.entry} ACTIVE hai. ` +
          `New plan blocked — original SL/TP manage karo.`,
      );
      return;
    }
    if (
      current?.status === "WAITING_ENTRY" &&
      !window.confirm(
        `${current.side} waiting plan @ ${current.levels.entry} cancel karke fresh plan banana hai?`,
      )
    ) {
      return;
    }
    setForceNewPlan((n) => n + 1);
  };

  const requestAssetChange = (nextAsset: AssetId) => {
    const current = planRef.current;
    if (current?.status === "IN_TRADE_HINT" && nextAsset !== assetId) {
      window.alert(
        `${current.side} ${current.assetId} trade ACTIVE hai. Active trade ke dauran asset switch blocked.`,
      );
      return;
    }
    setAssetId(nextAsset);
  };

  const requestModeChange = (nextMode: TradeMode) => {
    const current = planRef.current;
    if (current?.status === "IN_TRADE_HINT" && nextMode !== mode) {
      window.alert(
        `${current.side} ${current.mode} trade ACTIVE hai. Active trade ke dauran mode switch blocked.`,
      );
      return;
    }
    setMode(nextMode);
  };

  const copyAlertCmd = async () => {
    try {
      await navigator.clipboard.writeText("npm run alerts");
      await requestAlertPermission();
      testAlertSound();
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="app app-simple">
      <header className="topbar compact">
        <div className="brand">
          <span className="brand-mark">GO</span>
          <div>
            <h1>Trade Alert</h1>
            <p>Intraday = 1 zone / din · alert on lock + entry hit</p>
          </div>
        </div>
        <div className="topbar-meta">
          <span className={`live-dot ${quote && now - quote.ts < 2000 ? "on" : ""}`} />
          Live {pollMs}ms
          {plan && plan.status !== "INVALIDATED" && (
            <span className="updated">
              LOCKED {plan.side}
              {plan.entryZoneLow != null && plan.entryZoneHigh != null
                ? ` zone ${plan.entryZoneLow}–${plan.entryZoneHigh}`
                : ` @ ${plan.levels.entry}`}
              {plan.sessionDate ? ` · ${plan.sessionDate}` : ""}
            </span>
          )}
        </div>
      </header>

      <nav className="controls compact">
        <div className="asset-tabs">
          {ASSET_LIST.map((a) => (
            <button
              key={a.id}
              type="button"
              className={assetId === a.id ? "active" : ""}
              onClick={() => requestAssetChange(a.id)}
            >
              {a.name}
            </button>
          ))}
        </div>
        <div className="mode-toggle">
          <button
            type="button"
            className={mode === "scalping" ? "active" : ""}
            onClick={() => requestModeChange("scalping")}
          >
            Scalp
          </button>
          <button
            type="button"
            className={mode === "intraday" ? "active" : ""}
            onClick={() => requestModeChange("intraday")}
          >
            Intraday
          </button>
        </div>
        <button
          type="button"
          className="refresh-btn"
          onClick={requestNewPlan}
          disabled={plan?.status === "IN_TRADE_HINT"}
          title={
            plan?.status === "IN_TRADE_HINT"
              ? "Active trade complete/SL hone tak plan locked hai"
              : "Waiting plan cancel karke fresh setup check karein"
          }
        >
          {plan?.status === "IN_TRADE_HINT" ? "Trade active · locked" : "New plan"}
        </button>
      </nav>

      <main className="layout-simple">
        <div className="command-column">
          {loading && !nowAction && !booted && (
            <div className="panel loading">Loading…</div>
          )}
          {(error || quoteError) && (
            <div className="panel error">
              <p>{error || quoteError}</p>
            </div>
          )}
          {nowAction && (
            <ActionNow
              now={nowAction}
              assetId={assetId}
              alertsOn={alertsOn}
              onToggleAlerts={() => void toggleAlerts()}
              onTestSound={testAlertSound}
            />
          )}

          <BackgroundAlertBanner onStartHint={() => void copyAlertCmd()} />

          {signal && (
            <DetailsAccordion title="Advanced — bias, path, SMC detail">
              <PredictionPanel prediction={signal.rangePrediction} assetId={assetId} />
              <div className="bias-row">
                <BiasCard title="Daily bias" forecast={signal.dailyBias} assetId={assetId} />
                <BiasCard title="Tomorrow" forecast={signal.tomorrowBias} assetId={assetId} />
              </div>
              <StrategyBreakdown signal={signal} />
            </DetailsAccordion>
          )}
        </div>

        <div className="chart-column chart-compact">
          <div className="chart-shell chart-small">
            <div className="chart-label">
              <strong>{asset.name}</strong>
              {quote && (
                <span className="chart-live-px">{quote.price.toFixed(asset.decimals)}</span>
              )}
            </div>
            <TradingViewChart symbol={asset.tvSymbol} />
          </div>
        </div>
      </main>

      <p className="footer-note">
        Pehle <strong>Alerts ON</strong> + <strong>Test sound</strong> dabao (browser audio unlock).
        Plan lock = 4 beeps · Entry zone hit = 6 beeps. Intraday = 1 zone din bhar — sirf <strong>New plan</strong> se badlegi.
      </p>
    </div>
  );
}
