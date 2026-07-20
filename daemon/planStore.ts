import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetId, TradeMode } from "../src/types";
import type { FrozenPlan } from "../src/services/tradePlan";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DAEMON_DIR = __dirname;

/** Prefer data/ (Railway volume) so lock/dedupe state survives redeploys. */
function resolveStatePath(): string {
  const dataDir = process.env.DATA_DIR || join(process.cwd(), "data");
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    return join(dataDir, "alert-daemon-state.json");
  } catch {
    return join(DAEMON_DIR, "state.json");
  }
}

export const STATE_PATH = resolveStatePath();

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
    const base = defaultState();
    const watches = (raw.watches ?? base.watches).filter((w) => w.assetId === "XAUUSD");
    return {
      ...base,
      ...raw,
      watches: watches.length > 0 ? watches : base.watches,
      plans: raw.plans ?? {},
      lastAlertAt: raw.lastAlertAt ?? {},
    };
  } catch {
    return defaultState();
  }
}

export function saveDaemonState(state: DaemonState) {
  const dir = dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}
