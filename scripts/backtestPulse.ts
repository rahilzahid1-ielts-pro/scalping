import { writeFileSync } from "node:fs";
import { filterLastDays, loadHistoricalFile } from "../src/backtest/loadData";
import { runPulseBacktest } from "../src/pulse/backtest";
import { runQuickScalpBacktest } from "../src/quickScalp/backtest";
import { runProBacktest } from "../src/pro/backtest";

const file = "data/XAU_5m_data.csv";
const days = 365;
const spread = 0.25;
console.log("Loading", file);
const loaded = loadHistoricalFile(file);
const candles = filterLastDays(loaded.candles, days);
console.log("bars", candles.length);

const pulse = runPulseBacktest({ candles, days, spread, symbol: "XAUUSD" });
console.log("PULSE", JSON.stringify(pulse));
const qs = runQuickScalpBacktest({ candles, days, spread, symbol: "XAUUSD" });
console.log("QS", JSON.stringify({ n: qs.resolved, wr: qs.winRate, avgR: qs.avgR, sig: qs.signals }));
const pro = runProBacktest({ candles, days, spread, symbol: "XAUUSD" });
console.log("PRO", JSON.stringify({ n: pro.resolved, wr: pro.winRate, avgR: pro.avgR, sig: pro.signals }));

writeFileSync("data/_pulse_bt.json", JSON.stringify({ pulse, qsCompare: qs, proCompare: pro }, null, 2));
