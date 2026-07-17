import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetId, TradeMode } from "../src/types";
import type { FrozenPlan } from "../src/services/tradePlan";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DAEMON_DIR = __dirname;
export const STATE_PATH = join(DAEMON_DIR, "state.json");

export type DaemonWatch = {
  assetId: AssetId;
  mode: TradeMode;
};

export type DaemonState = {
  watches: DaemonWatch[];
  plans: Record<string, FrozenPlan | null>;
  lastAlertAt: Record<string, number>;
  minConfidence: number;
  minWinProb: number;
};

export function planKey(assetId: AssetId, mode: TradeMode) {
  return `${assetId}:${mode}`;
}

export function defaultState(): DaemonState {
  return {
    watches: [
      { assetId: "XAUUSD", mode: "intraday" },
      { assetId: "XAUUSD", mode: "scalping" },
      { assetId: "XAGUSD", mode: "intraday" },
      { assetId: "BTCUSD", mode: "scalping" },
    ],
    plans: {},
    lastAlertAt: {},
    minConfidence: 70,
    minWinProb: 65,
  };
}

export function loadDaemonState(): DaemonState {
  try {
    if (!existsSync(STATE_PATH)) return defaultState();
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<DaemonState>;
    return { ...defaultState(), ...raw, plans: raw.plans ?? {}, lastAlertAt: raw.lastAlertAt ?? {} };
  } catch {
    return defaultState();
  }
}

export function saveDaemonState(state: DaemonState) {
  if (!existsSync(DAEMON_DIR)) mkdirSync(DAEMON_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}
