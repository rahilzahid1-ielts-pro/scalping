import type { Candle, PriceActionSignal } from "../types";

function body(c: Candle) {
  return Math.abs(c.close - c.open);
}

function range(c: Candle) {
  return c.high - c.low || 1e-9;
}

function isBull(c: Candle) {
  return c.close > c.open;
}

function isBear(c: Candle) {
  return c.close < c.open;
}

export function analyzePriceAction(candles: Candle[]): PriceActionSignal {
  if (candles.length < 5) {
    return { pattern: "Insufficient data", bias: "NEUTRAL", score: 40, notes: [] };
  }

  const c0 = candles[candles.length - 1];
  const c1 = candles[candles.length - 2];
  const c2 = candles[candles.length - 3];
  const notes: string[] = [];
  let pattern = "No clear PA trigger";
  let bias: PriceActionSignal["bias"] = "NEUTRAL";
  let score = 42;

  const upperWick = c0.high - Math.max(c0.open, c0.close);
  const lowerWick = Math.min(c0.open, c0.close) - c0.low;
  const r = range(c0);

  // Pin bar / rejection
  if (lowerWick > body(c0) * 2 && lowerWick > upperWick * 1.5 && lowerWick / r > 0.55) {
    pattern = "Bullish Pin Bar / Rejection";
    bias = "BULLISH";
    score = 72;
    notes.push("Strong lower wick rejection — buyers defending lows");
  } else if (upperWick > body(c0) * 2 && upperWick > lowerWick * 1.5 && upperWick / r > 0.55) {
    pattern = "Bearish Pin Bar / Rejection";
    bias = "BEARISH";
    score = 72;
    notes.push("Strong upper wick rejection — sellers defending highs");
  }

  // Engulfing
  if (
    isBear(c1) &&
    isBull(c0) &&
    c0.open <= c1.close &&
    c0.close >= c1.open &&
    body(c0) > body(c1) * 1.05
  ) {
    pattern = "Bullish Engulfing";
    bias = "BULLISH";
    score = Math.max(score, 78);
    notes.push("Bullish engulfing candle — momentum shift up");
  } else if (
    isBull(c1) &&
    isBear(c0) &&
    c0.open >= c1.close &&
    c0.close <= c1.open &&
    body(c0) > body(c1) * 1.05
  ) {
    pattern = "Bearish Engulfing";
    bias = "BEARISH";
    score = Math.max(score, 78);
    notes.push("Bearish engulfing candle — momentum shift down");
  }

  // Inside bar breakout context
  if (c1.high < c2.high && c1.low > c2.low) {
    if (c0.close > c1.high) {
      pattern = "Inside Bar Breakout (Up)";
      bias = "BULLISH";
      score = Math.max(score, 70);
      notes.push("Compression → upside breakout");
    } else if (c0.close < c1.low) {
      pattern = "Inside Bar Breakout (Down)";
      bias = "BEARISH";
      score = Math.max(score, 70);
      notes.push("Compression → downside breakout");
    } else {
      notes.push("Inside bar forming — wait for break");
    }
  }

  // Three candle momentum
  if (isBull(c2) && isBull(c1) && isBull(c0) && c0.close > c1.close && c1.close > c2.close) {
    if (bias === "NEUTRAL") {
      pattern = "Bullish Momentum Sequence";
      bias = "BULLISH";
      score = 65;
    }
    notes.push("3 consecutive higher closes");
  } else if (isBear(c2) && isBear(c1) && isBear(c0) && c0.close < c1.close && c1.close < c2.close) {
    if (bias === "NEUTRAL") {
      pattern = "Bearish Momentum Sequence";
      bias = "BEARISH";
      score = 65;
    }
    notes.push("3 consecutive lower closes");
  }

  if (notes.length === 0) notes.push("Range / indecision — prioritize SMC structure");

  return { pattern, bias, score: Math.max(0, Math.min(100, score)), notes };
}
