import type { Dismissal } from "./account";
import { backend, isDesktop, type TasteCandidate, type TasteResponse, type TasteSeed } from "./backend";
import { contextFit, type Behaviour } from "./behaviour";
import { catalogRecord, recordItem } from "./catalog";
import { cachedCatalog } from "./persistentCache";
import { tmdb, type MediaItem, type MediaType, type TitleTaste } from "./tmdb";
import { key, type TasteSignal } from "./taste";
import type { Impression } from "../state/impressions";

const msPerDay = 86_400_000;
const seedLimit = 300;
const negativeLimit = 120;
const missingLookups = 12;
const tasteMaxAgeMs = 14 * msPerDay;
const mmrBalance = 0.75;
const ignoredAfter = 3;
const ignoredSpan = 6;
const strangerAnimeShare = 0.05;

export const featureNames = [
  "cosine",
  "ppr",
  "nearest",
  "negative",
  "quality",
  "novelty",
  "fresh",
  "kind",
  "language",
  "animeStranger",
  "avoided",
  "intent",
  "context",
  "ignored",
  "franchise",
  "subtitles",
] as const;

export const defaultWeights = [0.3, 0.22, 0.1, -0.3, 0.14, 0.04, 0.05, 0.06, 0.05, -0.25, -0.35, 0.1, 0.06, -0.2, 0.15, 0.03];

export interface Intent {
  keys: Map<string, number>;
  genres: Map<number, number>;
}

export interface ScoringContext {
  response: TasteResponse;
  behaviour: Behaviour | null;
  impressions: Map<string, Impression>;
  intent: Intent;
  uiLanguage: string;
  weights: number[];
  now: number;
}

export interface Scored {
  candidate: TasteCandidate;
  x: number[];
  score: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function keyParts(titleKey: string): { type: MediaType; id: number } {
  const [type, id] = titleKey.split(":");
  return { type: type === "tv" ? "tv" : "movie", id: Number(id) };
}

export function seedFromSignal(signal: TasteSignal, dismissal?: Dismissal): TasteSeed {
  return {
    key: key(signal.title),
    weight: Number(signal.weight.toFixed(4)),
    ...(signal.keep ? { keep: true } : {}),
    ...(dismissal?.reason ? { reason: dismissal.reason } : {}),
    ...(dismissal?.personId !== undefined ? { person: dismissal.personId } : {}),
  };
}

function extraFrom(taste: TitleTaste): TasteSeed["extra"] {
  return {
    genres: taste.item.genreIds,
    keywords: taste.keywords.map((keyword) => keyword.id),
    directors: taste.people.filter((person) => person.role === "director").map((person) => person.id),
    cast: taste.people.filter((person) => person.role === "cast").map((person) => person.id),
    recommendations: taste.recommendations.map((item) => item.id),
    collection: taste.collectionId,
    year: Number(taste.item.year) || 0,
    language: taste.item.language,
  };
}

export function engineAvailable(): boolean {
  return isDesktop || Boolean((globalThis as { __kinuzaMockTaste?: unknown }).__kinuzaMockTaste);
}

export async function askEngine(seeds: TasteSeed[], extra: Omit<Parameters<typeof backend.tasteRecommend>[0], "seeds"> = {}): Promise<TasteResponse | null> {
  if (!engineAvailable()) return null;
  const positive = seeds.filter((seed) => seed.weight > 0).slice(0, seedLimit);
  const negative = seeds.filter((seed) => seed.weight < 0).slice(0, negativeLimit);
  const request = { ...extra, seeds: [...positive, ...negative] };
  let response = await backend.tasteRecommend(request).catch(() => null);
  if (!response?.ready) return null;
  if (response.missing.length > 0) {
    const wanted = response.missing.slice(0, missingLookups);
    const found = await Promise.all(
      wanted.map((titleKey) => {
        const { type, id } = keyParts(titleKey);
        return cachedCatalog(`taste:${type}:${id}`, tasteMaxAgeMs, () => tmdb.taste(type, id)).catch(() => null);
      }),
    );
    const extras = new Map(wanted.flatMap((titleKey, index) => (found[index] ? [[titleKey, extraFrom(found[index]!)] as const] : [])));
    if (extras.size > 0) {
      const enriched = request.seeds.map((seed) => (extras.has(seed.key) ? { ...seed, extra: extras.get(seed.key) } : seed));
      response = (await backend.tasteRecommend({ ...request, seeds: enriched }).catch(() => null)) ?? response;
    }
  }
  return response;
}

function languageShare(response: TasteResponse, language: string): number {
  const strongest = Math.max(0, ...response.profile.languages.map(([, share]) => share));
  if (strongest <= 0) return 0;
  return (response.profile.languages.find(([code]) => code === language)?.[1] ?? 0) / strongest;
}

export function features(candidate: TasteCandidate, context: ScoringContext): number[] {
  const { response, behaviour, impressions, intent, uiLanguage, now } = context;
  const thisYear = new Date(now).getFullYear();
  const tv = candidate.key.startsWith("tv:");
  const seen = impressions.get(candidate.key);
  const ignored = seen && !seen.opened && seen.count > ignoredAfter ? Math.min(1, (seen.count - ignoredAfter) / ignoredSpan) : 0;
  const intentGenres = candidate.genres.length > 0 ? candidate.genres.reduce((sum, genre) => sum + (intent.genres.get(genre) ?? 0), 0) / candidate.genres.length : 0;
  const intentValue = Math.min(1, (intent.keys.get(candidate.key) ?? 0) * 4 + intentGenres * 0.6);
  const subtitleShare = behaviour && behaviour.language.seconds > 0 ? behaviour.language.subtitles / behaviour.language.seconds : 0.5;
  const foreign = candidate.language !== "" && candidate.language !== uiLanguage && candidate.language !== "en";
  return [
    candidate.cosine,
    candidate.ppr,
    candidate.nearest[0]?.similarity ?? 0,
    candidate.negative,
    clamp((candidate.quality - 6.5) / 1.5, -1, 1),
    1 - candidate.popularity,
    candidate.year > 0 ? clamp(1 - (thisYear - candidate.year) / 3, 0, 1) : 0,
    tv ? response.profile.tv : response.profile.movie,
    languageShare(response, candidate.language),
    candidate.anime && response.profile.anime < strangerAnimeShare ? 1 : 0,
    candidate.avoided,
    intentValue,
    behaviour ? contextFit(behaviour, candidate.runtime, tv, now) : 0,
    ignored,
    candidate.shared.some((shared) => shared.group === "collection") ? 1 : 0,
    foreign ? subtitleShare - 0.5 : 0,
  ];
}

export function scoreAll(context: ScoringContext): Scored[] {
  return context.response.candidates
    .map((candidate) => {
      const x = features(candidate, context);
      const score = x.reduce((sum, value, index) => sum + value * (context.weights[index] ?? 0), 0);
      return { candidate, x, score };
    })
    .sort((a, b) => b.score - a.score);
}

function sparseCosine(a: [number, number][], b: [number, number][]): number {
  let i = 0;
  let j = 0;
  let sum = 0;
  let normA = 0;
  let normB = 0;
  for (const [, value] of a) normA += value * value;
  for (const [, value] of b) normB += value * value;
  while (i < a.length && j < b.length) {
    if (a[i][0] === b[j][0]) {
      sum += a[i][1] * b[j][1];
      i++;
      j++;
    } else if (a[i][0] < b[j][0]) i++;
    else j++;
  }
  return normA > 0 && normB > 0 ? sum / Math.sqrt(normA * normB) : 0;
}

export function diversify(scored: Scored[], limit: number, skip: (entry: Scored) => boolean = () => false): Scored[] {
  const pool = scored.filter((entry) => !skip(entry)).slice(0, limit * 5);
  if (pool.length === 0) return [];
  const top = pool[0].score;
  const bottom = pool[pool.length - 1].score;
  const span = Math.max(1e-6, top - bottom);
  const picked: Scored[] = [];
  while (picked.length < limit && pool.length > 0) {
    let best = 0;
    let bestValue = -Infinity;
    pool.forEach((entry, index) => {
      const relevance = (entry.score - bottom) / span;
      let overlap = 0;
      for (const chosen of picked) overlap = Math.max(overlap, sparseCosine(entry.candidate.vector, chosen.candidate.vector));
      const previous = picked[picked.length - 1];
      const sameSeries = previous && entry.candidate.collection !== null && entry.candidate.collection === previous.candidate.collection;
      const value = mmrBalance * relevance - (1 - mmrBalance) * overlap - (sameSeries ? 1 : 0);
      if (value > bestValue) {
        bestValue = value;
        best = index;
      }
    });
    picked.push(...pool.splice(best, 1));
  }
  return picked;
}

export async function itemsFor(keys: string[]): Promise<Map<string, MediaItem>> {
  const records = await Promise.all(keys.map((titleKey) => {
    const { type, id } = keyParts(titleKey);
    return catalogRecord(type, id).catch(() => null);
  }));
  const items = new Map<string, MediaItem>();
  keys.forEach((titleKey, index) => {
    const record = records[index];
    if (record) items.set(titleKey, recordItem(record));
  });
  return items;
}

function gamma(shape: number, random: () => number): number {
  if (shape < 1) return gamma(shape + 1, random) * random() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    do {
      const u1 = Math.max(1e-12, random());
      const u2 = random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(successes: number, failures: number, random: () => number): number {
  const a = gamma(1 + successes, random);
  const b = gamma(1 + failures, random);
  return a / (a + b);
}
