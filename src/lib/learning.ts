import type { Dismissal } from "./account";
import { backend } from "./backend";
import type { Behaviour } from "./behaviour";
import { defaultWeights } from "./recommender";
import type { Impression } from "../state/impressions";
import type { Progress, TrackEntry } from "../state/library";

const msPerDay = 86_400_000;
const storeName = "taste-weights";
const startWindowDays = 21;
const ignoredImpressions = 4;
const fewestExamples = 30;
const fewestOfEach = 5;
const rounds = 300;
const step = 0.1;
const pullToDefaults = 0.3;
const retrainEveryMs = msPerDay;

export interface LearnedWeights {
  weights: number[];
  examples: number;
  positives: number;
  mix: number;
  trainedAt: number;
}

export type Outcome = 1 | 0 | null;

export interface OutcomeInput {
  tracked: Record<string, TrackEntry>;
  progress: Record<string, Progress>;
  dismissed: Record<string, Dismissal>;
  behaviour: Behaviour;
  now: number;
}

function watchedEpisodes(progress: Record<string, Progress>, titleKey: string): number {
  const prefix = `${titleKey}:`;
  let count = 0;
  for (const [unit, item] of Object.entries(progress)) {
    if (unit.startsWith(prefix) && item.duration > 0 && item.position / item.duration >= 0.9) count += 1;
  }
  return count;
}

export function outcomeOf(impression: Impression, input: OutcomeInput): Outcome {
  const { tracked, progress, dismissed, behaviour, now } = input;
  const dismissal = dismissed[impression.key];
  if (dismissal && dismissal.updatedAt >= impression.first) return 0;
  const started = behaviour.started.get(impression.key);
  const entry = tracked[impression.key];
  if (started !== undefined && started >= impression.first - msPerDay && started - impression.first <= startWindowDays * msPerDay) {
    if (entry?.status === "dropped") return 0;
    if (entry?.rating !== null && entry?.rating !== undefined && entry.rating <= 4) return 0;
    if (entry?.status === "completed" || (entry?.rating ?? 0) >= 7 || watchedEpisodes(progress, impression.key) >= 2) return 1;
    return null;
  }
  if (impression.count >= ignoredImpressions && !impression.opened && now - impression.first > 7 * msPerDay) return 0;
  return null;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

export function train(examples: { x: number[]; y: number }[], prior: number[] = defaultWeights): number[] {
  const weights = [...prior];
  let bias = 0;
  const count = examples.length;
  for (let round = 0; round < rounds; round++) {
    const gradient = new Array(weights.length).fill(0);
    let biasGradient = 0;
    for (const { x, y } of examples) {
      const predicted = sigmoid(bias + x.reduce((sum, value, index) => sum + value * weights[index], 0));
      const error = predicted - y;
      for (let index = 0; index < weights.length; index++) gradient[index] += error * (x[index] ?? 0);
      biasGradient += error;
    }
    for (let index = 0; index < weights.length; index++) {
      weights[index] -= step * (gradient[index] / count + pullToDefaults * (weights[index] - prior[index]));
    }
    bias -= step * (biasGradient / count);
  }
  return weights;
}

let learned: LearnedWeights | null = null;
let restored = false;

export async function currentWeights(): Promise<LearnedWeights | null> {
  if (!restored) {
    restored = true;
    const stored = await backend.storeGet(storeName).catch(() => null);
    try {
      const parsed = stored ? (JSON.parse(stored.text) as LearnedWeights) : null;
      if (parsed && Array.isArray(parsed.weights) && parsed.weights.length === defaultWeights.length) learned = parsed;
    } catch {
      learned = null;
    }
  }
  return learned;
}

export function blended(state: LearnedWeights | null): number[] {
  if (!state) return defaultWeights;
  return defaultWeights.map((prior, index) => prior + state.mix * ((state.weights[index] ?? prior) - prior));
}

export async function retrainIfDue(impressions: Map<string, Impression>, input: OutcomeInput): Promise<LearnedWeights | null> {
  const known = await currentWeights();
  if (known && input.now - known.trainedAt < retrainEveryMs) return known;
  const examples: { x: number[]; y: number }[] = [];
  for (const impression of impressions.values()) {
    if (!impression.x || impression.x.length !== defaultWeights.length || impression.arm?.startsWith("genre:")) continue;
    const outcome = outcomeOf(impression, input);
    if (outcome !== null) examples.push({ x: impression.x, y: outcome });
  }
  const positives = examples.filter((example) => example.y === 1).length;
  const negatives = examples.length - positives;
  if (examples.length < fewestExamples || positives < fewestOfEach || negatives < fewestOfEach) {
    learned = known ? { ...known, trainedAt: input.now } : null;
    return learned;
  }
  const weights = train(examples);
  learned = {
    weights: weights.map((value) => Number(value.toFixed(4))),
    examples: examples.length,
    positives,
    mix: Math.min(0.7, 0.15 + (examples.length - fewestExamples) / 200),
    trainedAt: input.now,
  };
  void backend.storeSet(storeName, JSON.stringify(learned)).catch(() => undefined);
  return learned;
}

export function armStats(impressions: Map<string, Impression>, input: OutcomeInput): Map<string, { successes: number; failures: number }> {
  const arms = new Map<string, { successes: number; failures: number }>();
  for (const impression of impressions.values()) {
    if (!impression.arm) continue;
    const outcome = impression.opened && outcomeOf(impression, input) === null ? 1 : outcomeOf(impression, input);
    if (outcome === null) continue;
    const entry = arms.get(impression.arm) ?? { successes: 0, failures: 0 };
    if (outcome === 1) entry.successes += 1;
    else entry.failures += 1;
    arms.set(impression.arm, entry);
  }
  return arms;
}

export interface FeedMetrics {
  impressions: number;
  titles: number;
  startShare: number | null;
  finishShare: number | null;
  complaintsPer100: number | null;
  learned: LearnedWeights | null;
}

export function feedMetrics(impressions: Map<string, Impression>, input: OutcomeInput): FeedMetrics {
  const { behaviour, dismissed, now } = input;
  let shownWeekAgo = 0;
  let startedInWeek = 0;
  let started = 0;
  let finished = 0;
  let complaints = 0;
  let shows = 0;
  for (const impression of impressions.values()) {
    shows += impression.count;
    const dismissal = dismissed[impression.key];
    if (dismissal && dismissal.updatedAt >= impression.first) complaints += 1;
    const startedAt = behaviour.started.get(impression.key);
    const startedAfter = startedAt !== undefined && startedAt >= impression.first - msPerDay;
    if (now - impression.first >= 7 * msPerDay) {
      shownWeekAgo += 1;
      if (startedAfter && startedAt! - impression.first <= 7 * msPerDay) startedInWeek += 1;
    }
    if (startedAfter) {
      started += 1;
      if (outcomeOf(impression, input) === 1) finished += 1;
    }
  }
  return {
    impressions: shows,
    titles: impressions.size,
    startShare: shownWeekAgo > 0 ? startedInWeek / shownWeekAgo : null,
    finishShare: started > 0 ? finished / started : null,
    complaintsPer100: shows > 0 ? (complaints / shows) * 100 : null,
    learned,
  };
}
