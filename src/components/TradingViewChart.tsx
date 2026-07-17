import { useEffect, useRef } from "react";

declare global {
  interface Window {
    TradingView?: {
      widget: new (options: Record<string, unknown>) => unknown;
    };
  }
}

interface Props {
  symbol: string;
  theme?: "dark" | "light";
}

export function TradingViewChart({ symbol }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = "";
    const widgetId = `tv_${symbol.replace(/[^a-zA-Z0-9]/g, "_")}_${Date.now()}`;
    const inner = document.createElement("div");
    inner.id = widgetId;
    inner.style.height = "100%";
    inner.style.width = "100%";
    container.appendChild(inner);

    const load = () => {
      if (!window.TradingView) return;
      new window.TradingView.widget({
        autosize: true,
        symbol,
        interval: "15",
        timezone: "Etc/UTC",
        theme: "dark",
        style: "1",
        locale: "en",
        toolbar_bg: "#0c1219",
        enable_publishing: false,
        hide_top_toolbar: false,
        hide_legend: false,
        save_image: false,
        calendar: false,
        studies: ["MAExp@tv-basicstudies"],
        container_id: widgetId,
        backgroundColor: "#0c1219",
        gridColor: "rgba(140, 160, 180, 0.08)",
        allow_symbol_change: false,
        withdateranges: true,
        details: false,
        hotlist: false,
      });
    };

    if (window.TradingView) {
      load();
      return;
    }

    const existing = document.getElementById("tradingview-widget-script");
    if (existing) {
      existing.addEventListener("load", load);
      return () => existing.removeEventListener("load", load);
    }

    const script = document.createElement("script");
    script.id = "tradingview-widget-script";
    script.src = "https://s3.tradingview.com/tv.js";
    script.async = true;
    script.onload = load;
    document.head.appendChild(script);
  }, [symbol]);

  return <div className="tv-chart" ref={containerRef} />;
}
