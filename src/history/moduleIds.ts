/**
 * Browser-safe module id helpers (no sqlite / node imports).
 * Keep server-only lock lookup in activeLock.ts.
 */

export type ActiveModuleId =
  | "scalp"
  | "intraday"
  | "quick_scalp"
  | "qs_pro"
  | "pro"
  | "intra30"
  | "cipher_b"
  | "fractal";

export function historyModuleToActiveId(module: string): ActiveModuleId | null {
  const m = module.toLowerCase();
  if (m === "scalp" || m === "scalping") return "scalp";
  if (m === "intraday") return "intraday";
  if (m === "quick_scalp" || m === "quickscalp") return "quick_scalp";
  if (m === "qs_pro" || m === "pulse") return "qs_pro";
  if (m === "pro") return "pro";
  if (m === "intra30") return "intra30";
  if (m === "cipher_b" || m === "cipher_b_clone" || m === "cipherb") return "cipher_b";
  if (m === "fractal") return "fractal";
  return null;
}
