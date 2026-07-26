/**
 * Persist / load trained learn model under data/learn/.
 *
 * Railway mounts a volume at /app/data which hides git-tracked files under
 * data/learn. Seed copies from learn-seed/ (outside the volume) into
 * data/learn/ on first boot when missing — never overwrites newer volume files.
 */
import {
  copyFileSync,
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
/** Repo seed outside Railway /app/data volume mount. */
export const LEARN_SEED_DIR = join(ROOT, "learn-seed");
export const MODEL_PATH = join(LEARN_DIR, "sl_model.json");
export const REPORT_PATH = join(LEARN_DIR, "last_report.json");

const SEED_FILES = [
  "sl_model.json",
  "sl_model.prev.json",
  "scenario_playbook.json",
  "last_report.json",
  "by_year_report.json",
  "last_weekly_run.json",
  "labeled_20y.jsonl.gz",
] as const;

let seedRan = false;
let lastSeedReport: { copied: string[]; missing: string[]; seedDir: string } | null =
  null;

/**
 * Copy missing learn artifacts from learn-seed/ → data/learn/.
 * Safe to call repeatedly; skips files that already exist on the volume.
 */
export function ensureLearnSeeded(): {
  copied: string[];
  missing: string[];
  seedDir: string;
} {
  if (!existsSync(LEARN_DIR)) mkdirSync(LEARN_DIR, { recursive: true });

  const copied: string[] = [];
  const missing: string[] = [];

  for (const name of SEED_FILES) {
    const dest = join(LEARN_DIR, name);
    if (existsSync(dest)) continue;
    const src = join(LEARN_SEED_DIR, name);
    if (!existsSync(src)) {
      missing.push(name);
      continue;
    }
    try {
      copyFileSync(src, dest);
      copied.push(name);
    } catch {
      missing.push(name);
    }
  }

  seedRan = true;
  lastSeedReport = { copied, missing, seedDir: LEARN_SEED_DIR };
  if (copied.length > 0) {
    console.log(
      `[learn] seeded ${copied.length} file(s) into data/learn from learn-seed:`,
      copied.join(", "),
    );
  }
  return lastSeedReport;
}

export function getLearnSeedReport() {
  if (!seedRan) ensureLearnSeeded();
  return lastSeedReport;
}

export function saveModel(model: TrainedModel, path = MODEL_PATH): void {
  if (!existsSync(LEARN_DIR)) mkdirSync(LEARN_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(model, null, 2));
}

export function loadModel(path = MODEL_PATH): TrainedModel | null {
  ensureLearnSeeded();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as TrainedModel;
    // Back-compat for models trained before TP/playbook fields
    raw.tpWins ??= [];
    raw.moduleMarket ??= [];
    raw.playbook ??= [];
    return raw;
  } catch {
    return null;
  }
}

export function saveReport(report: unknown): void {
  if (!existsSync(LEARN_DIR)) mkdirSync(LEARN_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}
