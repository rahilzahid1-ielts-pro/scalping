import type { AssetId, TradeMode } from "../types";
import type { FrozenPlan } from "./tradePlan";

export type CurrentPlanResponse = {
  ok: boolean;
  assetId?: AssetId;
  mode?: TradeMode;
  plan?: FrozenPlan | null;
  workerRunning?: boolean;
  error?: string;
};

/** Read authoritative locked plan from alertBot (server SoT). */
export async function fetchCurrentPlan(
  mode: TradeMode,
  assetId: AssetId = "XAUUSD",
): Promise<FrozenPlan | null> {
  const q = new URLSearchParams({ mode, assetId });
  const res = await fetch(`/api/plan/current?${q}`);
  if (!res.ok) throw new Error(`plan/current HTTP ${res.status}`);
  const data = (await res.json()) as CurrentPlanResponse;
  if (!data.ok) throw new Error(data.error || "plan/current failed");
  return data.plan ?? null;
}

/** Clear server lock for this mode (UI New plan). */
export async function clearCurrentPlan(
  mode: TradeMode,
  assetId: AssetId = "XAUUSD",
): Promise<void> {
  const q = new URLSearchParams({ mode, assetId });
  const res = await fetch(`/api/plan/clear?${q}`, { method: "POST" });
  if (!res.ok) throw new Error(`plan/clear HTTP ${res.status}`);
  const data = (await res.json()) as CurrentPlanResponse;
  if (!data.ok) throw new Error(data.error || "plan/clear failed");
}
