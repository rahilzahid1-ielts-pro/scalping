/**
 * Shared HTTP handlers for authoritative plan API (prodServer + Vite).
 * Lock decisions stay in alertBot; this only exposes read/clear.
 */
import type { AssetId, TradeMode } from "../src/types";

function parseMode(raw: string | null): TradeMode | null {
  if (!raw) return null;
  const m = raw.toLowerCase();
  if (m === "scalping" || m === "scalp") return "scalping";
  if (m === "intraday") return "intraday";
  return null;
}

function parseAssetId(raw: string | null): AssetId {
  if (raw === "XAUUSD") return "XAUUSD";
  return "XAUUSD";
}

export async function handleGetCurrentPlan(searchParams: URLSearchParams): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const mode = parseMode(searchParams.get("mode"));
  if (!mode) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "mode required: scalping|scalp|intraday",
      },
    };
  }
  const assetId = parseAssetId(searchParams.get("assetId"));
  const {
    ensureAlertWorker,
    getAuthoritativePlan,
    isAlertWorkerRunning,
  } = await import("./alertBot");
  ensureAlertWorker();
  const plan = getAuthoritativePlan(assetId, mode);
  return {
    status: 200,
    body: {
      ok: true,
      assetId,
      mode,
      plan,
      workerRunning: isAlertWorkerRunning(),
    },
  };
}

export async function handleClearCurrentPlan(searchParams: URLSearchParams): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const mode = parseMode(searchParams.get("mode"));
  if (!mode) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "mode required: scalping|scalp|intraday",
      },
    };
  }
  const assetId = parseAssetId(searchParams.get("assetId"));
  const {
    ensureAlertWorker,
    clearAuthoritativePlan,
    getAuthoritativePlan,
    isAlertWorkerRunning,
  } = await import("./alertBot");
  ensureAlertWorker();
  clearAuthoritativePlan(assetId, mode);
  return {
    status: 200,
    body: {
      ok: true,
      assetId,
      mode,
      plan: getAuthoritativePlan(assetId, mode),
      workerRunning: isAlertWorkerRunning(),
    },
  };
}
