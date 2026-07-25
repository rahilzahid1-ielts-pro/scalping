/**
 * Logistic regression P(SL) — pure TS, no extra deps.
 */
import {
  buildContextFlags,
  extractFeatures,
  featureNames,
  labelOf,
} from "./features";
import { mineSlCauses } from "./explain";
import {
  buildScenarioPlaybook,
  mineTpWins,
  moduleMarketMatrix,
} from "./scenarios";
import type { LearnRow, TrainedModel } from "./types";

function sigmoid(z: number): number {
  if (z > 20) return 1;
  if (z < -20) return 0;
  return 1 / (1 + Math.exp(-z));
}

function predictProba(weights: number[], x: number[]): number {
  // x[0] is unused bias slot in feature vector; weights[0] is bias
  let z = weights[0];
  for (let i = 1; i < weights.length && i < x.length; i++) {
    z += weights[i] * x[i];
  }
  return sigmoid(z);
}

export function trainLogisticSlModel(
  rows: LearnRow[],
  opts?: { testFrac?: number; epochs?: number; lr?: number; l2?: number },
): TrainedModel {
  if (rows.length < 8) {
    throw new Error(`Need ≥8 EXECUTED resolved rows, got ${rows.length}`);
  }

  const names = featureNames();
  const ctx = buildContextFlags(rows);
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    X.push(extractFeatures(rows[i], ctx[i]).vector);
    y.push(labelOf(rows[i]));
  }

  const testFrac = opts?.testFrac ?? 0.25;
  const epochs = opts?.epochs ?? 500;
  const lr = opts?.lr ?? 0.1;
  const l2 = opts?.l2 ?? 0.015;

  // Time-ordered holdout (last 25%) — no shuffle leak across days
  const testN = Math.max(2, Math.floor(rows.length * testFrac));
  const split = rows.length - testN;
  const trainIdx = Array.from({ length: split }, (_, i) => i);
  const testIdx = Array.from({ length: testN }, (_, i) => split + i);

  const trainLoss = trainIdx.filter((i) => y[i] === 1).length;
  const trainWin = trainIdx.length - trainLoss;
  // Mild balance — heavy SL weight collapses holdout into “always SL”
  const wSl = trainLoss > 0 ? Math.min(1.6, trainIdx.length / (2.2 * trainLoss)) : 1;
  const wWin = trainWin > 0 ? Math.min(1.2, trainIdx.length / (2.2 * trainWin)) : 1;

  const weights = new Array(names.length).fill(0);
  weights[0] = Math.log((trainLoss + 1) / (trainWin + 1)); // prior

  for (let ep = 0; ep < epochs; ep++) {
    for (const i of trainIdx) {
      const x = X[i];
      const p = predictProba(weights, x);
      const err = p - y[i];
      const cw = y[i] === 1 ? wSl : wWin;
      weights[0] -= lr * cw * err;
      for (let j = 1; j < weights.length; j++) {
        weights[j] -= lr * (cw * err * x[j] + l2 * weights[j]);
      }
    }
  }

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let correct = 0;
  for (const i of testIdx) {
    const p = predictProba(weights, X[i]);
    const pred = p >= 0.5 ? 1 : 0;
    const actual = y[i];
    if (pred === actual) correct += 1;
    if (pred === 1 && actual === 1) tp += 1;
    else if (pred === 1 && actual === 0) fp += 1;
    else if (pred === 0 && actual === 1) fn += 1;
  }

  const lossN = y.filter((v) => v === 1).length;
  const winN = y.length - lossN;
  const precisionSl = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recallSl = tp + fn > 0 ? tp / (tp + fn) : 0;

  const moduleHourSlRate: TrainedModel["moduleHourSlRate"] = {};
  for (let i = 0; i < rows.length; i++) {
    const hour = new Date(rows[i].executedAt + 5 * 3600_000).getUTCHours();
    const key = `${rows[i].module}|${hour}`;
    const slot = (moduleHourSlRate[key] ??= { n: 0, sl: 0, rate: 0 });
    slot.n += 1;
    if (y[i] === 1) slot.sl += 1;
  }
  for (const k of Object.keys(moduleHourSlRate)) {
    const s = moduleHourSlRate[k];
    s.rate = s.n > 0 ? s.sl / s.n : 0;
  }

  const slCauses = mineSlCauses(rows);
  const tpWins = mineTpWins(rows);
  const moduleMarket = moduleMarketMatrix(rows);
  const playbook = buildScenarioPlaybook(rows);

  return {
    version: 1,
    trainedAt: new Date().toISOString(),
    sampleN: rows.length,
    winN,
    lossN,
    featureNames: names,
    weights,
    metrics: {
      trainN: trainIdx.length,
      testN,
      accuracy: testN > 0 ? correct / testN : 0,
      precisionSl,
      recallSl,
      baselineSlRate: rows.length > 0 ? lossN / rows.length : 0,
    },
    slCauses,
    tpWins,
    moduleMarket,
    playbook: playbook.slice(0, 120),
    moduleHourSlRate,
    thresholds: {
      // Prefer keep firing — only block when model is fairly sure
      blockP: 0.55,
      preferBlockP: 0.68,
    },
  };
}

export function predictSlProbability(
  model: TrainedModel,
  vector: number[],
): number {
  return predictProba(model.weights, vector);
}
