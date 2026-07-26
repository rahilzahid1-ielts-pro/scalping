/**
 * GET /api/learn/status — model + weekly worker + day confidence snapshot.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureLearnSeeded,
  LEARN_DIR,
  LEARN_SEED_DIR,
  loadModel,
  REPORT_PATH,
} from "./modelStore";
import { getCachedDayRegime } from "../regime/dayModuleRules";
import { daysSinceLastWeeklyRun } from "../../scripts/learnWeekly";
import { shouldAutoStartWeeklyLearnWorker } from "../../daemon/weeklyLearnBot";

const LABELS_PATH = join(LEARN_DIR, "labeled_20y.jsonl");
const LABELS_GZ = join(LEARN_DIR, "labeled_20y.jsonl.gz");
const STAMP_PATH = join(LEARN_DIR, "last_weekly_run.json");
const PLAYBOOK_PATH = join(LEARN_DIR, "scenario_playbook.json");

function readStamp(): {
  at: number | null;
  atIso: string | null;
  sampleN: number | null;
  wr: number | null;
  liveAdded: number | null;
  ok: boolean | null;
} {
  if (!existsSync(STAMP_PATH)) {
    return {
      at: null,
      atIso: null,
      sampleN: null,
      wr: null,
      liveAdded: null,
      ok: null,
    };
  }
  try {
    const s = JSON.parse(readFileSync(STAMP_PATH, "utf8")) as {
      at?: number;
      atIso?: string;
      sampleN?: number;
      wr?: number | null;
      liveAdded?: number;
      ok?: boolean;
    };
    return {
      at: s.at ?? null,
      atIso: s.atIso ?? (s.at ? new Date(s.at).toISOString() : null),
      sampleN: s.sampleN ?? null,
      wr: s.wr ?? null,
      liveAdded: s.liveAdded ?? null,
      ok: s.ok ?? null,
    };
  } catch {
    return {
      at: null,
      atIso: null,
      sampleN: null,
      wr: null,
      liveAdded: null,
      ok: null,
    };
  }
}

function weeklyStatusLabel(
  enabled: boolean,
  daysSince: number | null,
  stampOk: boolean | null,
): "off" | "ok" | "never" | "stale" {
  if (!enabled) return "off";
  if (daysSince == null) return "never";
  if (stampOk === false) return "stale";
  if (daysSince > 9) return "stale";
  return "ok";
}

export async function buildLearnStatusPayload() {
  const seed = ensureLearnSeeded();
  const model = loadModel();
  const stamp = readStamp();
  const daysSince = daysSinceLastWeeklyRun();
  const weeklyEnabled = shouldAutoStartWeeklyLearnWorker();
  const weeklyState = weeklyStatusLabel(weeklyEnabled, daysSince, stamp.ok);

  let reportSource: string | null = null;
  if (existsSync(REPORT_PATH)) {
    try {
      const r = JSON.parse(readFileSync(REPORT_PATH, "utf8")) as {
        source?: string;
      };
      reportSource = r.source ?? null;
    } catch {
      /* ignore */
    }
  }

  const day = getCachedDayRegime();
  const modules = day
    ? Object.values(day.byModule).map((m) => ({
        module: m.module,
        tier: m.tier,
        confidencePct: m.confidencePct,
        winRate: m.winRate,
        allowNewLock: m.allowNewLock,
        wins: m.score.wins,
        losses: m.score.losses,
        executed: m.score.executed,
      }))
    : [];

  const wr =
    model && model.sampleN > 0
      ? Math.round((model.winN / model.sampleN) * 1000) / 10
      : null;

  return {
    ok: true,
    at: Date.now(),
    running: Boolean(model),
    model: {
      loaded: Boolean(model),
      trainedAt: model?.trainedAt ?? null,
      sampleN: model?.sampleN ?? 0,
      winN: model?.winN ?? 0,
      lossN: model?.lossN ?? 0,
      wr,
      playbookN: model?.playbook?.length ?? 0,
      source: reportSource,
      gateActive: Boolean(model),
    },
    weekly: {
      enabled: weeklyEnabled,
      state: weeklyState,
      lastRunAt: stamp.at,
      lastRunIso: stamp.atIso,
      lastOk: stamp.ok,
      lastSampleN: stamp.sampleN,
      lastWr: stamp.wr,
      liveAdded: stamp.liveAdded,
      daysSince: daysSince != null ? Math.round(daysSince * 10) / 10 : null,
      nextHint: "Sunday ~22:00 PKT",
    },
    labels: {
      jsonl: existsSync(LABELS_PATH),
      gz: existsSync(LABELS_GZ),
      playbookFile: existsSync(PLAYBOOK_PATH),
    },
    paths: {
      learnDir: LEARN_DIR,
      seedDir: LEARN_SEED_DIR,
    },
    seed: {
      copied: seed.copied,
      missing: seed.missing,
    },
    day: day
      ? {
          date: day.date,
          refreshedAt: day.refreshedAt,
          modules,
        }
      : null,
  };
}
