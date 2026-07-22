import { useMemo } from "react";

interface Props {
  symbol: string;
  theme?: "dark" | "light";
}

/**
 * Direct TradingView widgetembed iframe.
 * Avoids tv.js / embed-script races that left the Gold panel blank.
 */
export function TradingViewChart({ symbol, theme = "dark" }: Props) {
  const src = useMemo(() => {
    const params = new URLSearchParams({
      frameElementId: "tv_gold_desk",
      symbol,
      interval: "15",
      hidesidetoolbar: "0",
      hidetoptoolbar: "0",
      symboledit: "0",
      saveimage: "0",
      toolbarbg: "0c1219",
      studies: JSON.stringify(["MAExp@tv-basicstudies"]),
      theme,
      style: "1",
      timezone: "Etc/UTC",
      withdateranges: "1",
      hideideas: "1",
      hidelegend: "0",
      studies_overrides: "{}",
      overrides: "{}",
      enabled_features: "[]",
      disabled_features: "[]",
      locale: "en",
      utm_source: "gold-signal-desk",
      utm_medium: "widget",
      utm_campaign: "chart",
      utm_term: symbol,
    });
    return `https://s.tradingview.com/widgetembed/?${params.toString()}`;
  }, [symbol, theme]);

  return (
    <div className="tv-chart">
      <iframe
        title={`${symbol} chart`}
        src={src}
        className="tv-chart-iframe"
        allowFullScreen
        loading="eager"
        referrerPolicy="origin-when-cross-origin"
      />
    </div>
  );
}
