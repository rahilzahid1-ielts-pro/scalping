import { useEffect, useId, useRef } from "react";

interface Props {
  symbol: string;
  theme?: "dark" | "light";
}

/**
 * TradingView Advanced Chart embed.
 * Uses the official external-embedding script (more reliable than legacy tv.js),
 * waits for a non-zero container size, and cleans up on remount (React Strict Mode).
 */
export function TradingViewChart({ symbol }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const reactId = useId().replace(/:/g, "");
  const widgetHostId = `tv_host_${reactId}`;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let scriptEl: HTMLScriptElement | null = null;
    let bootTimer: number | undefined;

    const mount = () => {
      if (cancelled || !containerRef.current) return;
      const host = containerRef.current;
      // Wipe previous embed (Strict Mode remount / symbol change).
      host.innerHTML = "";

      const widgetRoot = document.createElement("div");
      widgetRoot.className = "tradingview-widget-container";
      widgetRoot.style.height = "100%";
      widgetRoot.style.width = "100%";

      const widgetInner = document.createElement("div");
      widgetInner.className = "tradingview-widget-container__widget";
      widgetInner.style.height = "100%";
      widgetInner.style.width = "100%";
      widgetRoot.appendChild(widgetInner);
      host.appendChild(widgetRoot);

      const config = {
        autosize: true,
        symbol,
        interval: "15",
        timezone: "Etc/UTC",
        theme: "dark",
        style: "1",
        locale: "en",
        backgroundColor: "#0c1219",
        gridColor: "rgba(140, 160, 180, 0.08)",
        hide_top_toolbar: false,
        hide_legend: false,
        allow_symbol_change: false,
        calendar: false,
        support_host: "https://www.tradingview.com",
        studies: ["MAExp@tv-basicstudies"],
      };

      scriptEl = document.createElement("script");
      scriptEl.src =
        "https://s.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
      scriptEl.type = "text/javascript";
      scriptEl.async = true;
      scriptEl.textContent = JSON.stringify(config);
      widgetRoot.appendChild(scriptEl);
    };

    const tryMountWhenSized = () => {
      if (cancelled || !containerRef.current) return;
      const { clientWidth, clientHeight } = containerRef.current;
      if (clientWidth < 40 || clientHeight < 40) return;
      observer?.disconnect();
      observer = null;
      // Small delay so CSS layout settles after desk tab switches.
      window.clearTimeout(bootTimer);
      bootTimer = window.setTimeout(mount, 50);
    };

    observer = new ResizeObserver(() => tryMountWhenSized());
    observer.observe(container);
    tryMountWhenSized();

    return () => {
      cancelled = true;
      window.clearTimeout(bootTimer);
      observer?.disconnect();
      if (containerRef.current) containerRef.current.innerHTML = "";
    };
  }, [symbol, widgetHostId]);

  return (
    <div
      className="tv-chart"
      id={widgetHostId}
      ref={containerRef}
      style={{ minHeight: 320 }}
    />
  );
}
