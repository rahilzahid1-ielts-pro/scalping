import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ASSETS } from "./config/assets";
import { fetchMultiTimeframe } from "./services/marketData";
import { generateSignal } from "./strategies/signalEngine";
import type { AssetId, LiveSignal, TradeMode } from "./types";
import { TradingViewChart } from "./components/TradingViewChart";
import { ActionNow } from "./components/ActionNow";
import { WatchSetupCard } from "./components/WatchSetupCard";
import { QuickScalpCard } from "./components/QuickScalpCard";
import { ProCard } from "./components/ProCard";
import { Intra30Card } from "./components/Intra30Card";
import { PulseCard } from "./components/PulseCard";
import { HistoryCard } from "./components/HistoryCard";
import { DemoAccountCard } from "./components/DemoAccountCard";
import { StrategyCompareCard } from "./components/StrategyCompareCard";
import { DetailsAccordion } from "./components/DetailsAccordion";
import { BiasCard } from "./components/BiasCard";
import { PredictionPanel } from "./components/PredictionPanel";
import { StrategyBreakdown } from "./components/StrategyBreakdown";
import { useLivePrice } from "./hooks/useLivePrice";
import { requestAlertPermission, testAlertSound, useEntryAlert, usePlanLockAlert } from "./hooks/useEntryAlert";
import { useServiceWorkerAlerts } from "./hooks/useServiceWorkerAlerts";
import { enablePush, getPushState, sendTestPush, type PushState } from "./services/pushClient";
import { roundPrice } from "./strategies/indicators";
import { computeNowAction } from "./utils/nowAction";
import { signalInterval } from "./utils/sessionPlan";
import { loadSession, saveSession, type FrozenPlan } from "./services/tradePlan";
import { clearCurrentPlan, fetchCurrentPlan } from "./services/planClient";
import { isLiquiditySweepAgainst } from "./utils/liquidityWarning";
import { CONFLICT_CAP_PCT } from "./calibration/types";
import { displayedWinChance } from "./calibration/winChanceDisplay";

const boot = loadSession();

export default function App() {
  const [assetId] = useState<AssetId>("XAUUSD");
  const [mode, setMode] = useState<TradeMode>(boot.mode);
  /** Isolated Quick Scalp desk view — does not change main Scalp/Intraday mode. */
  const [deskView, setDeskView] = useState<
    | "main"
    | "quick_scalp"
    | "pro"
    | "intra30"
    | "pulse"
    | "cipher_b"
    | "fractal"
    | "history"
    | "demo"
  >("main");
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoMsg, setDemoMsg] = useState<string | null>(null);
  const [signal, setSignal] = useState<LiveSignal | null>(null);
  /** Live engine lean while a locked plan is active (second box). */
  const [watchSignal, setWatchSignal] = useState<LiveSignal | null>(null);
  /** Display cache of server plan; lock decisions live in alertBot only. */
  const [plan, setPlan] = useState<FrozenPlan | null>(boot.plan);
  const [forceNewPlan, setForceNewPlan] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [alertsOn, setAlertsOn] = useState(boot.alertsOn);
  const [pushState, setPushState] = useState<PushState>("default");
  const [pushBusy, setPushBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [booted, setBooted] = useState(false);
  const [liquidityWarn, setLiquidityWarn] = useState(false);

  const { quote, error: quoteError, pollMs } = useLivePrice(assetId);
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  const planRef = useRef(plan);
  planRef.current = plan;
  const skipClearRef = useRef(true);

  const asset = ASSETS[assetId];
  // Display-only mode filter (Issue 1): never show another mode's cached plan.
  const planForThisMode = plan && plan.mode === mode ? plan : null;
  const hasActivePlan =
    !!planForThisMode &&
    planForThisMode.assetId === assetId &&
    planForThisMode.status !== "INVALIDATED";
  const refreshMs = signalInterval(mode, hasActivePlan);

  useEffect(() => {
    // localStorage = paint cache only — not lock authority.
    saveSession({ assetId, mode, plan, alertsOn });
  }, [assetId, mode, plan, alertsOn]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setLiquidityWarn(false);
      const livePx = quoteRef.current?.price;
      const [frames, server] = await Promise.all([
        fetchMultiTimeframe(assetId, mode, livePx),
        fetchCurrentPlan(mode, assetId),
      ]);
      const next = generateSignal(assetId, mode, frames);
      const q = quoteRef.current?.price;
      if (q != null) next.price = roundPrice(q, asset.decimals);

      // Server SoT: when worker is up and plan is null, clear local ghost locks
      // (Incognito vs normal mismatch was paint-cache keeping a dead BUY after SL/redeploy).
      // Only keep paint-cache briefly when worker is down (redeploy gap).
      let nextPlan = server.plan;
      if (
        !nextPlan &&
        !server.workerRunning &&
        planRef.current &&
        planRef.current.mode === mode &&
        planRef.current.assetId === assetId &&
        planRef.current.status !== "INVALIDATED" &&
        (planRef.current.side === "BUY" || planRef.current.side === "SELL")
      ) {
        nextPlan = planRef.current;
      }
      setPlan(nextPlan);
      planRef.current = nextPlan;

      const active =
        nextPlan &&
        nextPlan.mode === mode &&
        nextPlan.status !== "INVALIDATED" &&
        (nextPlan.side === "BUY" || nextPlan.side === "SELL")
          ? nextPlan
          : null;

      if (active) {
        // Keep raw engine lean for the live watch box (new setup while trade OPEN).
        const leanDiffers =
          next.side !== "WAIT" &&
          !!next.levels &&
          (next.side !== active.side ||
            Math.abs(next.levels.entry - active.levels.entry) >= 0.5);
        setWatchSignal(leanDiffers ? { ...next, levels: { ...next.levels! } } : null);

        next.levels = active.levels;
        next.side = active.side;
        const swept = isLiquiditySweepAgainst(active.side, frames.primary);
        setLiquidityWarn(swept);
        if (active.lockedConfidence != null) {
          next.confidence = active.lockedConfidence;
          next.rangePrediction = {
            ...next.rangePrediction,
            confidence: active.lockedConfidence,
            winProbability: displayedWinChance(active.lockedConfidence, {
              conflictCapped:
                next.diagnostics.conflictCapped || next.diagnostics.conflictingSignals,
            }),
          };
        } else if (active.lockedWinProbability != null) {
          next.rangePrediction = {
            ...next.rangePrediction,
            winProbability: active.lockedWinProbability,
          };
        }
        if (next.diagnostics.conflictCapped || next.diagnostics.conflictingSignals) {
          next.confidence = Math.min(next.confidence, CONFLICT_CAP_PCT);
          next.rangePrediction = {
            ...next.rangePrediction,
            confidence: Math.min(next.rangePrediction.confidence, CONFLICT_CAP_PCT),
            winProbability: displayedWinChance(next.confidence, { conflictCapped: true }),
          };
        }
      } else {
        setWatchSignal(null);
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
      // Mode switch: drop paint-cache until this mode's server plan arrives.
      // Server keeps each mode's lock independently (no client preserveActive).
      setPlan(null);
      planRef.current = null;
      setSignal(null);
      setWatchSignal(null);
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
    void (async () => {
      try {
        await clearCurrentPlan(mode, assetId);
        setPlan(null);
        planRef.current = null;
        saveSession({ assetId, mode, plan: null, alertsOn });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "New plan failed");
      }
    })();
  }, [forceNewPlan]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 300);
    return () => window.clearInterval(id);
  }, []);

  const livePrice = quote?.price ?? signal?.price ?? 0;

  const nowAction = useMemo(() => {
    if (!signal || !livePrice) return null;
    return computeNowAction(
      signal,
      planForThisMode,
      livePrice,
      asset,
      quote,
      liquidityWarn,
    );
  }, [signal, planForThisMode, livePrice, asset, quote, liquidityWarn]);

  /** Second box: live engine lean while locked trade is still running. */
  const showWatch =
    !!watchSignal &&
    !!livePrice &&
    hasActivePlan &&
    watchSignal.side !== "WAIT" &&
    !!watchSignal.levels;

  // Key ONLY on locked entry — refresh must not reset alert arming wrongly
  const planKey = planForThisMode
    ? `${planForThisMode.assetId}-${planForThisMode.mode}-${planForThisMode.side}-${planForThisMode.levels.entry}-${planForThisMode.lockedAt}`
    : "none";

  usePlanLockAlert(
    planForThisMode?.status !== "INVALIDATED" ? planForThisMode : null,
    alertsOn,
  );
  useEntryAlert({ now: nowAction, enabled: alertsOn, planKey });
  useServiceWorkerAlerts(nowAction, alertsOn, planKey, planForThisMode);

  useEffect(() => {
    void getPushState().then(setPushState);
  }, []);

  const toggleAlerts = async () => {
    await requestAlertPermission();
    setAlertsOn((a) => !a);
  };

  const enablePushNotifications = async () => {
    const { state, error } = await enablePush();
    setPushState(state);
    if (error) console.warn("[push]", error);
  };

  const testPushNotification = async () => {
    setPushBusy(true);
    try {
      const result = await sendTestPush();
      setPushState(await getPushState());
      if (!result.ok) {
        window.alert(
          `Test Push FAIL\n${result.error ?? "unknown"}\nsubs=${result.subscriptions ?? 0}`,
        );
        return;
      }
      window.alert(
        `Test Push SENT\ndelivered=${result.delivered} / subscriptions=${result.subscriptions}\n\nAb app band karke dekho — notification aani chahiye. Agar app khuli hai tab bhi banner dikhega.`,
      );
    } finally {
      setPushBusy(false);
    }
  };

  const takeDemoTrade = async () => {
    if (!nowAction || (nowAction.side !== "BUY" && nowAction.side !== "SELL")) {
      setDemoMsg("Pehle BUY/SELL setup chahiye");
      return;
    }
    if (nowAction.entry == null || nowAction.stopLoss == null || nowAction.takeProfit == null) {
      setDemoMsg("Entry / SL / TP missing");
      return;
    }
    setDemoBusy(true);
    setDemoMsg(null);
    try {
      const res = await fetch("/api/demo/take", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          side: nowAction.side,
          entry: nowAction.entry,
          sl: nowAction.stopLoss,
          tp1: nowAction.takeProfit,
          tp2: nowAction.takeProfit2 ?? null,
          module: mode === "intraday" ? "intraday" : "scalp",
          note: `Manual ${mode} ${nowAction.side} from desk`,
        }),
      });
      const j = (await res.json()) as {
        ok: boolean;
        error?: string;
        account?: { balance: number };
        position?: { riskUsd: number };
      };
      if (!j.ok) {
        setDemoMsg(j.error || "Demo take failed");
        return;
      }
      setDemoMsg(
        `Demo OPEN · risk $${j.position?.riskUsd?.toFixed(2) ?? "?"} · bal $${j.account?.balance.toFixed(2) ?? "?"}`,
      );
    } catch (e) {
      setDemoMsg(e instanceof Error ? e.message : "Demo take failed");
    } finally {
      setDemoBusy(false);
    }
  };

  const requestNewPlan = () => {
    const current = planForThisMode;
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

  const requestModeChange = (nextMode: TradeMode) => {
    // Free tab navigation — each mode's lock lives on the server independently.
    setMode(nextMode);
  };

  return (
    <div className="app app-simple">
      <header className="topbar compact">
        <div className="brand">
          <span className="brand-mark">GO</span>
          <div>
            <h1>Trade Alert</h1>
            <p>Intraday = 1 lock / din · live mid updates · naya setup alag watch box</p>
          </div>
        </div>
        <div className="topbar-meta">
          <span className={`live-dot ${quote && now - quote.ts < 2000 ? "on" : ""}`} />
          Live {pollMs}ms
          <button
            type="button"
            className={`topbar-push ${pushState === "subscribed" ? "on" : ""}`}
            onClick={() => void enablePushNotifications()}
            disabled={pushState === "unsupported" || pushState === "denied"}
            title={
              pushState === "subscribed"
                ? "Closed-app push ON — phone pe alert aayega jab app band ho"
                : pushState === "denied"
                  ? "Notifications blocked — phone Settings → Site notifications ON karo"
                  : "Home-screen app band hone pe bhi trade alert ke liye Push ON karo"
            }
          >
            {pushState === "subscribed"
              ? "✅ Push ON"
              : pushState === "denied"
                ? "Push Blocked"
                : pushState === "unsupported"
                  ? "Push N/A"
                  : "🔔 Enable Push"}
          </button>
          <button
            type="button"
            className="topbar-push"
            onClick={() => void testPushNotification()}
            disabled={pushBusy || pushState === "unsupported" || pushState === "denied"}
            title="Server se asli Web Push bhejo — closed-app test"
          >
            {pushBusy ? "Sending…" : "Test Push"}
          </button>
          {planForThisMode && planForThisMode.status !== "INVALIDATED" && (
            <span className="updated">
              LOCKED {planForThisMode.side}
              {planForThisMode.entryZoneLow != null && planForThisMode.entryZoneHigh != null
                ? ` zone ${planForThisMode.entryZoneLow}–${planForThisMode.entryZoneHigh}`
                : ` @ ${planForThisMode.levels.entry}`}
              {planForThisMode.sessionDate ? ` · ${planForThisMode.sessionDate}` : ""}
            </span>
          )}
        </div>
      </header>

      <nav className="controls compact">
        <div className="asset-tabs">
          <button type="button" className="active" disabled>
            Gold
          </button>
        </div>
        <div className="mode-toggle">
          <button
            type="button"
            className={deskView === "history" ? "active" : ""}
            onClick={() => setDeskView("history")}
          >
            History
          </button>
          <button
            type="button"
            className={deskView === "demo" ? "active" : ""}
            onClick={() => setDeskView("demo")}
          >
            Demo $
          </button>
          <button
            type="button"
            className={deskView === "main" && mode === "scalping" ? "active" : ""}
            onClick={() => {
              setDeskView("main");
              requestModeChange("scalping");
            }}
          >
            Scalp
          </button>
          <button
            type="button"
            className={deskView === "main" && mode === "intraday" ? "active" : ""}
            onClick={() => {
              setDeskView("main");
              requestModeChange("intraday");
            }}
          >
            Intraday
          </button>
          <button
            type="button"
            className={deskView === "intra30" ? "active" : ""}
            onClick={() => setDeskView("intra30")}
          >
            Intra30
          </button>
          <button
            type="button"
            className={deskView === "quick_scalp" ? "active" : ""}
            onClick={() => setDeskView("quick_scalp")}
          >
            Quick Scalp
          </button>
          <button
            type="button"
            className={deskView === "pulse" ? "active" : ""}
            onClick={() => setDeskView("pulse")}
          >
            QS Pro
          </button>
          <button
            type="button"
            className={deskView === "pro" ? "active" : ""}
            onClick={() => setDeskView("pro")}
          >
            Pro
          </button>
          <button
            type="button"
            className={deskView === "cipher_b" ? "active" : ""}
            onClick={() => setDeskView("cipher_b")}
          >
            Cipher B
          </button>
          <button
            type="button"
            className={deskView === "fractal" ? "active" : ""}
            onClick={() => setDeskView("fractal")}
          >
            TTrades Fractal
          </button>
        </div>
        <button
          type="button"
          className="refresh-btn"
          onClick={requestNewPlan}
          disabled={planForThisMode?.status === "IN_TRADE_HINT"}
          title={
            planForThisMode?.status === "IN_TRADE_HINT"
              ? "Active trade complete/SL hone tak plan locked hai"
              : "Waiting plan cancel karke fresh setup check karein"
          }
        >
          {planForThisMode?.status === "IN_TRADE_HINT"
            ? "Trade active · locked"
            : "New plan"}
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
          {deskView === "history" ? (
            <HistoryCard />
          ) : deskView === "demo" ? (
            <DemoAccountCard />
          ) : deskView === "quick_scalp" ? (
            <QuickScalpCard />
          ) : deskView === "pro" ? (
            <ProCard />
          ) : deskView === "intra30" ? (
            <Intra30Card />
          ) : deskView === "pulse" ? (
            <PulseCard />
          ) : deskView === "cipher_b" ? (
            <StrategyCompareCard
              title="CIPHER B · Gold"
              subtitle="WaveTrend Cipher-B + SMC dual-confirm · trend only · TP1 @ 0.9R"
              apiPath="/api/cipherbclone/latest"
              cacheKey="cipher_b"
              moduleLabel="Cipher B"
            />
          ) : deskView === "fractal" ? (
            <StrategyCompareCard
              title="TTRADES FRACTAL · Gold"
              subtitle="Fractal + SMC agree · daily agree · no 2h spike-chase · TP1 @ 0.9R"
              apiPath="/api/fractal/latest"
              cacheKey="fractal"
              moduleLabel="TTrades Fractal"
            />
          ) : (
            <>
              {nowAction && (
                <ActionNow
                  now={nowAction}
                  assetId={assetId}
                  alertsOn={alertsOn}
                  onToggleAlerts={() => void toggleAlerts()}
                  onTestSound={testAlertSound}
                  pushState={pushState}
                  onEnablePush={() => void enablePushNotifications()}
                  onTestPush={() => void testPushNotification()}
                  pushBusy={pushBusy}
                  onTakeDemo={() => void takeDemoTrade()}
                  demoBusy={demoBusy}
                  demoMsg={demoMsg}
                />
              )}
              {deskView === "main" && showWatch && watchSignal && (
                <WatchSetupCard
                  signal={watchSignal}
                  livePrice={livePrice}
                  quote={quote}
                  assetId={assetId}
                />
              )}
            </>
          )}

          {deskView === "main" && signal && (
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
        <strong>Alerts ON</strong> = app khuli ho tab sound.{" "}
        <strong>Enable Push</strong> (upar) = app band / home-screen pe bhi notification.
        iPhone: Safari → Share → Add to Home Screen, phir Push ON. Plan lock = 4 beeps · Entry = 6
        beeps.
      </p>
    </div>
  );
}
