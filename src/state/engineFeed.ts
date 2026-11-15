import type { Dismissal } from "../lib/account";
import type { TasteSeed } from "../lib/backend";
import { readBehaviour, type Behaviour } from "../lib/behaviour";
import { catalogSearch } from "../lib/catalog";
import { currentLanguage, t } from "../lib/i18n";
import { armStats, blended, retrainIfDue, type OutcomeInput } from "../lib/learning";
import { cachedCatalog } from "../lib/persistentCache";
import { parseQuery } from "../lib/queryIntent";
import { askEngine, diversify, engineAvailable, featureNames, itemsFor, sampleBeta, scoreAll, seedFromSignal, type Intent, type Scored } from "../lib/recommender";
import { bestRated, dismissalSignals, interestSignals, key, tasteSignals, type TasteSignal } from "../lib/taste";
import { tmdb, type MediaItem } from "../lib/tmdb";
import { readActivity } from "./activity";
import { loadImpressions } from "./impressions";
import type { Progress, TrackEntry } from "./library";

const msPerDay = 86_400_000;
const historyDays = 2 * 365;
const forYouLimit = 20;
const rowLimit = 18;
const shortestRow = 5;
const shortestCollectionRow = 3;
const clusterRowLimit = 4;
const clusterShare = 0.12;
const bothSeedsSimilarity = 0.3;
const similarSeedSimilarity = 0.12;
const explorePositions = [5, 13];
const exploreGenres = [28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 53, 10752, 37];
const likedGenreShare = 0.08;
const exploreMinVotes = 800;
const gemPopularity = 0.75;
const gemQuality = 7.0;
const gemVotes = 100;
const personRowLimit = 2;
const listMaxAgeMs = 3 * msPerDay;
const nameMaxAgeMs = 60 * msPerDay;
const searchHalfLifeMs = msPerDay;
const likeSearchWeight = 0.3;
const reasonWeight = 0.3;

export interface EngineItem extends MediaItem {
  note?: string;
  signals?: number[];
  arm?: string;
  countries?: string[];
}

export interface EngineRow {
  id: string;
  title: string;
  items: EngineItem[];
}

function seededRandom(seed: number): () => number {
  let state = seed % 2147483647 || 1;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

async function searchIntent(behaviour: Behaviour, now: number): Promise<{ intent: Intent; seeds: TasteSeed[] }> {
  const intent: Intent = { keys: new Map(), genres: new Map() };
  const seeds: TasteSeed[] = [];
  for (const [titleKey, interest] of behaviour.interest) intent.keys.set(titleKey, interest.score);
  for (const search of behaviour.searches) {
    const fade = 0.5 ** ((now - search.at) / searchHalfLifeMs);
    const parsed = parseQuery(search.query);
    for (const genre of parsed.filters.genres ?? []) intent.genres.set(genre, Math.max(intent.genres.get(genre) ?? 0, fade));
    if (parsed.like) {
      const found = await catalogSearch(parsed.like).catch(() => []);
      const first = found[0]?.item;
      if (first) seeds.push({ key: key(first), weight: Number((likeSearchWeight * fade).toFixed(4)), keep: true });
    }
  }
  return { intent, seeds };
}

function rounded(values: number[]): number[] {
  return values.map((value) => Number(value.toFixed(3)));
}

export async function buildEngineFeed(
  tracked: Record<string, TrackEntry>,
  progress: Record<string, Progress>,
  dismissed: Record<string, Dismissal>,
): Promise<EngineRow[] | null> {
  if (!engineAvailable()) return null;
  const now = Date.now();
  const events = await readActivity(now - historyDays * msPerDay).catch(() => []);
  const behaviour = readBehaviour(events, now);
  const signals = tasteSignals(tracked, progress, now, behaviour);
  if (!signals.some((signal) => signal.weight > 0)) return null;
  const dismissals = dismissalSignals(dismissed, tracked, now);
  const interests = interestSignals(behaviour, tracked, dismissed, now);
  const { intent, seeds: searchSeeds } = await searchIntent(behaviour, now);

  const seeds: TasteSeed[] = [
    ...signals.filter((signal) => signal.weight > 0).map((signal) => seedFromSignal(signal)),
    ...interests.map((signal) => seedFromSignal(signal)),
    ...searchSeeds,
    ...signals.filter((signal) => signal.weight < 0).map((signal) => seedFromSignal(signal)),
    ...dismissals.map((signal) => seedFromSignal(signal, dismissed[key(signal.title)])),
  ];
  const avoidPeople = Object.values(dismissed).flatMap((dismissal) => (dismissal.reason === "person" && dismissal.personId !== undefined ? [dismissal.personId] : []));
  const exclude = [...Object.keys(tracked), ...Object.keys(dismissed)];
  const response = await askEngine(seeds, { exclude, avoidPeople });
  if (!response || response.candidates.length === 0) return null;

  const impressions = await loadImpressions();
  const outcomes: OutcomeInput = { tracked, progress, dismissed, behaviour, now };
  const learned = await retrainIfDue(impressions, outcomes).catch(() => null);
  const weights = blended(learned);
  const scored = scoreAll({ response, behaviour, impressions, intent, uiLanguage: currentLanguage(), weights, now });

  const random = seededRandom(Math.floor(now / msPerDay) * 7919 + 17);
  const arms = armStats(impressions, outcomes);
  const exploring = await exploration(response.profile.genres, arms, exclude, random);

  const signalTitles = new Map<string, TasteSignal>(signals.map((signal) => [key(signal.title), signal]));
  const referenced = new Set<string>();
  for (const entry of scored.slice(0, 400)) for (const near of entry.candidate.nearest) referenced.add(near.key);
  for (const cluster of response.clusters) cluster.seeds.slice(0, 2).forEach((seed) => referenced.add(seed));
  const candidateKeys = [...new Set([...scored.slice(0, 400).map((entry) => entry.candidate.key), ...exploring.map((entry) => entry.candidate.key)])];
  const items = await itemsFor([...candidateKeys, ...referenced]);
  const nameOf = (titleKey: string) => {
    const signal = signalTitles.get(titleKey);
    if (!signal || signal.weight < reasonWeight) return "";
    return items.get(titleKey)?.title || signal.title.title || "";
  };

  const shown = new Set<string>();
  const rows: EngineRow[] = [];
  const toItem = (entry: Scored, arm?: string): EngineItem | null => {
    const item = items.get(entry.candidate.key);
    if (!item || !item.poster) return null;
    return { ...item, note: noteFor(entry, nameOf, arm), signals: rounded(entry.x), arm, countries: entry.candidate.countries };
  };
  const push = (row: EngineRow, shortest = shortestRow) => {
    if (row.items.length < shortest) return;
    for (const item of row.items) shown.add(key(item));
    rows.push(row);
  };
  const pick = (entries: Scored[], limit: number, arm?: (entry: Scored) => string | undefined): EngineItem[] => {
    const picked: EngineItem[] = [];
    for (const entry of diversify(entries, limit + 10, (candidate) => shown.has(candidate.candidate.key))) {
      const item = toItem(entry, arm?.(entry));
      if (item) picked.push(item);
      if (picked.length >= limit) break;
    }
    return picked;
  };

  const clusterArm = (cluster: number) => {
    const seed = response.clusters[cluster]?.seeds[0];
    return seed ? `seed:${seed}` : undefined;
  };
  const forYou = pick(scored, forYouLimit, (entry) => clusterArm(entry.candidate.cluster));
  const exploreItems = exploring.flatMap((entry) => {
    if (shown.has(entry.candidate.key) || forYou.some((item) => key(item) === entry.candidate.key)) return [];
    const item = toItem(entry, entry.arm);
    return item ? [item] : [];
  });
  explorePositions.forEach((position, index) => {
    const item = exploreItems[index];
    if (item && forYou.length >= position) forYou.splice(position, 0, item);
  });
  push({ id: "for-you", title: t("feed.forYou"), items: forYou.slice(0, forYouLimit + explorePositions.length) });

  const franchise = scored.filter((entry) => entry.x[featureNames.indexOf("franchise")] > 0);
  if (franchise.length > 0) push({ id: "collections", title: t("feed.collections"), items: pick(franchise, rowLimit) }, shortestCollectionRow);

  const totalWeight = response.clusters.reduce((sum, cluster) => sum + cluster.weight, 0) || 1;
  const clusterOrder = response.clusters
    .map((cluster, index) => {
      const arm = arms.get(clusterArm(index) ?? "") ?? { successes: 0, failures: 0 };
      return { cluster, index, draw: sampleBeta(arm.successes, arm.failures, random) * (cluster.weight / totalWeight) };
    })
    .filter(({ cluster }) => response.clusters.length > 1 && cluster.weight / totalWeight >= clusterShare && cluster.seeds.length >= 2)
    .sort((a, b) => b.draw - a.draw)
    .slice(0, clusterRowLimit);
  for (const { cluster, index } of clusterOrder) {
    const [first, second] = cluster.seeds.map(nameOf).filter(Boolean);
    if (!first) continue;
    push({
      id: `cluster:${cluster.seeds[0]}`,
      title: second ? t("feed.cluster", { first, second }) : t("feed.similarTo", { title: first }),
      items: pick(
        scored.filter((entry) => entry.candidate.cluster === index),
        rowLimit,
        () => clusterArm(index),
      ),
    });
  }

  const thisYear = new Date(now).getFullYear();
  const fresh = scored.filter((entry) => entry.candidate.year >= thisYear - 1);
  push({ id: "fresh", title: t("feed.fresh"), items: pick(fresh, rowLimit) });

  const gems = scored.filter(
    (entry) => entry.candidate.popularity < gemPopularity && entry.candidate.quality >= gemQuality && entry.candidate.votes >= gemVotes,
  );
  push({ id: "gems", title: t("feed.gems"), items: pick(gems, rowLimit) });

  const known = new Set(exclude);
  for (const person of response.people.slice(0, personRowLimit)) {
    const role = person.role;
    const [name, films] = await Promise.all([
      cachedCatalog(`person-name:${person.id}`, nameMaxAgeMs, () => tmdb.personName(person.id)).catch(() => ""),
      cachedCatalog(`person:${role}:${person.id}`, listMaxAgeMs, () => tmdb.personFilms(person.id, role)).catch(() => [] as MediaItem[]),
    ]);
    if (!name) continue;
    const unseen = bestRated(films).filter((item) => !known.has(key(item)) && !shown.has(key(item)) && item.poster);
    const title = role === "director" ? t("feed.person.director", { name }) : role === "writer" ? t("feed.person.writer", { name }) : t("feed.person.cast", { name });
    push({ id: `person:${person.id}`, title, items: unseen.slice(0, rowLimit) });
  }

  return rows;
}

interface ExploreEntry extends Scored {
  arm: string;
}

async function exploration(
  genres: [number, number][],
  arms: Map<string, { successes: number; failures: number }>,
  exclude: string[],
  random: () => number,
): Promise<ExploreEntry[]> {
  const liked = new Map(genres);
  const options = exploreGenres
    .filter((genre) => (liked.get(genre) ?? 0) < likedGenreShare)
    .map((genre) => {
      const stats = arms.get(`genre:${genre}`) ?? { successes: 0, failures: 0 };
      return { genre, draw: sampleBeta(stats.successes, stats.failures, random) };
    })
    .sort((a, b) => b.draw - a.draw)
    .slice(0, explorePositions.length);
  const found: ExploreEntry[] = [];
  for (const { genre } of options) {
    const response = await askEngine([], { filters: { genres: [genre] }, minVotes: exploreMinVotes, exclude, limit: 30 });
    const candidate = response?.candidates.find((entry) => entry.avoided === 0);
    if (!candidate) continue;
    const x = featureNames.map(() => 0);
    x[featureNames.indexOf("quality")] = Math.max(-1, Math.min(1, (candidate.quality - 6.5) / 1.5));
    found.push({ candidate, x, score: 0, arm: `genre:${genre}` });
  }
  return found;
}

function noteFor(entry: Scored, nameOf: (titleKey: string) => string, arm?: string): string | undefined {
  if (arm?.startsWith("genre:")) return t("feed.reason.explore");
  const { candidate } = entry;
  const named = candidate.nearest.filter((near) => nameOf(near.key) !== "");
  const nearest = named[0];
  const nearName = nearest ? nameOf(nearest.key) : "";
  const groups = new Set(candidate.shared.map((shared) => shared.group));
  if (nearName && groups.has("collection")) return t("feed.reason.collection", { title: nearName });
  if (nearName && groups.has("director")) return t("feed.reason.sameDirector", { title: nearName });
  const second = named[1];
  const secondName = second ? nameOf(second.key) : "";
  if (nearName && secondName && second.similarity >= bothSeedsSimilarity) return t("feed.reason.both", { first: nearName, second: secondName });
  if (nearName && groups.has("writer")) return t("feed.reason.sameWriter", { title: nearName });
  if (nearName && groups.has("cast")) return t("feed.reason.sameCast", { title: nearName });
  if (nearName && nearest.similarity >= similarSeedSimilarity) return t("feed.similarTo", { title: nearName });
  return undefined;
}

const holdoutSize = 10;
const holdoutFewest = 15;
const holdoutDepth = 20;
const holdoutWeight = 0.3;

export interface HoldoutResult {
  hidden: number;
  engine: number;
  classic: number | null;
  testedAt: number;
}

export async function engineHoldout(
  tracked: Record<string, TrackEntry>,
  progress: Record<string, Progress>,
  dismissed: Record<string, Dismissal>,
  classic: (hidden: Set<string>) => Promise<number | null>,
): Promise<HoldoutResult | null> {
  const now = Date.now();
  const events = await readActivity(now - historyDays * msPerDay).catch(() => []);
  const behaviour = readBehaviour(events, now);
  const signals = tasteSignals(tracked, progress, now, behaviour);
  const positives = signals.filter((signal) => signal.weight >= holdoutWeight);
  if (positives.length < holdoutFewest) return null;
  const hidden = new Set([...positives].sort((a, b) => b.at - a.at).slice(0, holdoutSize).map((signal) => key(signal.title)));
  const seeds = signals.filter((signal) => !hidden.has(key(signal.title))).map((signal) => seedFromSignal(signal));
  const exclude = [...Object.keys(tracked), ...Object.keys(dismissed)].filter((titleKey) => !hidden.has(titleKey));
  const response = await askEngine(seeds, { exclude });
  if (!response) return null;
  const impressions = new Map();
  const scored = scoreAll({
    response,
    behaviour,
    impressions,
    intent: { keys: new Map(), genres: new Map() },
    uiLanguage: currentLanguage(),
    weights: blended(await retrainIfDue(await loadImpressions(), { tracked, progress, dismissed, behaviour, now }).catch(() => null)),
    now,
  });
  const top = diversify(scored, holdoutDepth);
  const engine = top.filter((entry) => hidden.has(entry.candidate.key)).length;
  const classicHits = await classic(hidden).catch(() => null);
  return { hidden: hidden.size, engine, classic: classicHits, testedAt: now };
}
