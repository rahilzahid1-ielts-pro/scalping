/**
 * Persist / load trained learn model under data/learn/.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrainedModel } from "./types";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const LEARN_DIR = join(ROOT, "data", "learn");
export const MODEL_PATH = join(LEARN_DIR, "sl_model.json");
export const REPORT_PATH = join(LEARN_DIR, "last_report.json");

export function saveModel(model: TrainedModel, path = MODEL_PATH): void {
  if (!existsSync(LEARN_DIR)) mkdirSync(LEARN_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(model, null, 2));
}

export function loadModel(path = MODEL_PATH): TrainedModel | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TrainedModel;
  } catch {
    return null;
  }
}

export function saveReport(report: unknown): void {
  if (!existsSync(LEARN_DIR)) mkdirSync(LEARN_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}
