import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { Dismissal } from "../lib/account";
import { backend } from "../lib/backend";
import { t } from "../lib/i18n";
import { cachedCatalog } from "../lib/persistentCache";
import { catalogLanguage, tmdb, type MediaItem, type MediaType, type TitleTaste } from "../lib/tmdb";
import {
  bestRated,
  buildProfile,
  defaultPreset,
  dismissalSignals,
  favoriteGenres,
  favoriteKeywords,
  key,
  rankCandidates,
  tasteSignals,
  weightPresets,
  type CandidateSource,
  type PersonAffinity,
  type Reason,
  type Seed,
  type TasteProfile,
  type TasteSignal,
} from "../lib/taste";
import { useLibrary, type Progress, type TrackEntry } from "./library";

const msPerDay = 86_400_000;
const strongestSeedLimit = 8;
const recentSeedLimit = 4;
const randomSeedLimit = 3;
const recentSeedDays = 30;
const dislikedSeedLimit = 4;
const dismissedSeedLimit = 4;
const forYouLimit = 20;
const rowLimit = 18;
const becauseRowLimit = 2;
const genreRowLimit = 2;
const themeLimit = 3;
const collectionSeedLimit = 3;
const personRowLimit = 2;
const fewestTitlesForPersonRow = 2;
const shortestRow = 5;
const shortestCollectionRow = 3;
const rowWorthyRating = 6.3;
const likedRating = 7;
const freshDays = 270;
const tasteMaxAgeMs = 14 * msPerDay;
const listMaxAgeMs = 3 * msPerDay;
const collectionMaxAgeMs = 7 * msPerDay;
const feedMaxAgeMs = 12 * 60 * 60 * 1000;
const rebuildDelayMs = 2500;
const typeShareForThemes = 0.25;
const strengths = { collection: 1.2, person: 0.8, theme: 0.9, fresh: 0.45, genre: 0.35 };

const tuningStore = "taste-tuning";
const feedStore = "feed";
const tuningEveryMs = 7 * msPerDay;
const tuningPositives = 12;
const tuningRounds = 3;
const tuningHiddenShare = 0.2;
const tuningDepth = 40;
const tuningPositiveWeight = 0.3;

const seriesGenreIds: Record<number, number> = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 };
const filmOnlyGenres = new Set([27, 53, 10749, 36, 10402]);

export interface FeedItem extends MediaItem {
  note?: string;
}

export interface FeedRow {
  id: string;
  title: string;
  items: FeedItem[];
}

export interface TuningResult {
  preset: string;
  hits: Record<string, number>;
  hidden: number;
  testedAt: number;
}

function seededRandom(seed: number): () => number {
  let state = seed % 2147483647 || 1;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

function weightedPick<T>(items: T[], weightOf: (item: T) => number, count: number, random: () => number): T[] {
  const pool = [...items];
  const picked: T[] = [];
  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((sum, item) => sum + weightOf(item), 0);
    let roll = random() * total;
    const index = pool.findIndex((item) => (roll -= weightOf(item)) <= 0);
    picked.push(...pool.splice(index < 0 ? pool.length - 1 : index, 1));
  }
  return picked;
}

export function chooseSeeds(signals: TasteSignal[], dismissals: TasteSignal[], now: number, random: () => number): TasteSignal[] {
  const positive = signals.filter((signal) => signal.weight > 0);
  const strongest = positive.slice(0, strongestSeedLimit);
  const taken = new Set(strongest.map((signal) => key(signal.title)));
  const recent = positive
    .filter((signal) => !taken.has(key(signal.title)) && now - signal.at < recentSeedDays * msPerDay)
    .sort((a, b) => b.at - a.at)
    .slice(0, recentSeedLimit);
  for (const signal of recent) taken.add(key(signal.title));
  const lucky = weightedPick(
    positive.filter((signal) => !taken.has(key(signal.title))),
    (signal) => signal.weight,
    randomSeedLimit,
    random,
  );
  return [
    ...strongest,
    ...recent,
    ...lucky,
    ...signals.filter((signal) => signal.weight < 0).slice(0, dislikedSeedLimit),
    ...dismissals.slice(0, dismissedSeedLimit),
  ];
}

function taste(type: MediaType, id: number): Promise<TitleTaste> {
  return cachedCatalog(`taste:${type}:${id}`, tasteMaxAgeMs, () => tmdb.taste(type, id));
}

function settled<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

function dayNumber(now: number): number {
  return Math.floor(now / msPerDay);
}

interface Gathered {
  seeds: Seed[];
  profile: TasteProfile;
  extra: CandidateSource[];
  people: PersonAffinity[];
  personLists: MediaItem[][];
  themes: CandidateSource[];
  fresh: CandidateSource[];
  collections: CandidateSource[];
  genreType: MediaType;
  genreRequests: { genre: number; id: number }[];
  genreLists: PromiseSettledResult<MediaItem[]>[];
}

async function gather(chosen: TasteSignal[]): Promise<Gathered | null> {
  const sources = await Promise.allSettled(chosen.map((signal) => taste(signal.title.type, signal.title.id)));
  const seeds: Seed[] = chosen.flatMap((signal, index) => {
    const result = sources[index];
    return result.status === "fulfilled" ? [{ signal, source: result.value }] : [];
  });
  if (!seeds.some((seed) => seed.signal.weight > 0)) return null;

  const profile = buildProfile(seeds);
  const today = new Date().toISOString().slice(0, 10);

  const people = profile.people.filter((person) => person.titles >= fewestTitlesForPersonRow).slice(0, personRowLimit);
  const strongestPerson = Math.max(1e-6, ...people.map((person) => person.affinity));
  const keywords = favoriteKeywords(profile, themeLimit);
  const strongestKeyword = Math.max(1e-6, ...keywords.map((keyword) => keyword.affinity));
  const themeTypes = (["movie", "tv"] as MediaType[]).filter((type) => profile.types[type] >= typeShareForThemes);
  const genres = favoriteGenres(profile, genreRowLimit);
  const genreType: MediaType = profile.types.tv > profile.types.movie ? "tv" : "movie";
  const genreRequests = genres
    .filter((genre) => genreType === "movie" || !filmOnlyGenres.has(genre))
    .map((genre) => ({ genre, id: genreType === "tv" ? (seriesGenreIds[genre] ?? genre) : genre }));
  const freshGenres = favoriteGenres(profile, 3);
  const collectionSeeds = seeds
    .filter((seed) => seed.signal.weight >= tuningPositiveWeight && seed.source.collectionId !== null && seed.source.item.type === "movie")
    .slice(0, collectionSeedLimit);

  const [personLists, themeLists, freshLists, genreLists, collectionLists] = await Promise.all([
    Promise.all(
      people.map((person) =>
        cachedCatalog(`person:${person.role}:${person.id}`, listMaxAgeMs, () => tmdb.personFilms(person.id, person.role)).catch(() => []),
      ),
    ),
    Promise.all(
      keywords.flatMap((keyword) =>
        themeTypes.map((type) =>
          cachedCatalog(`theme:${type}:${keyword.id}`, listMaxAgeMs, () => tmdb.byKeywords(type, [keyword.id]))
            .then((items) => ({ keyword, items }))
            .catch(() => ({ keyword, items: [] as MediaItem[] })),
        ),
      ),
    ),
    freshGenres.length > 0
      ? Promise.all(
          themeTypes.map((type) =>
            cachedCatalog(`fresh:${type}:${freshGenres.join(",")}`, listMaxAgeMs, () => tmdb.recentByGenres(type, freshGenres, freshDays)).catch(
              () => [],
            ),
          ),
        )
      : Promise.resolve([] as MediaItem[][]),
    Promise.allSettled(
      genreRequests.map((request) => cachedCatalog(`genre:${genreType}:${request.id}`, listMaxAgeMs, () => tmdb.bestOfGenre(genreType, request.id))),
    ),
    Promise.all(
      collectionSeeds.map((seed) =>
        cachedCatalog(`collection:${seed.source.collectionId}`, collectionMaxAgeMs, () => tmdb.collection(seed.source.collectionId!))
          .then((collection) => ({ seed, parts: collection.parts.filter((part) => part.releaseDate !== "" && part.releaseDate <= today) }))
          .catch(() => ({ seed, parts: [] })),
      ),
    ),
  ]);

  const collections: CandidateSource[] = collectionLists.flatMap(({ seed, parts }) =>
    parts.map((item) => ({ item, kind: "collection" as const, strength: seed.signal.weight * strengths.collection, reason: { kind: "collection" as const, title: seed.signal.title } })),
  );
  const personSources: CandidateSource[] = people.flatMap((person, index) =>
    personLists[index].map((item) => ({
      item,
      kind: "person" as const,
      strength: (person.affinity / strongestPerson) * strengths.person,
      reason: { kind: "person" as const, name: person.name, role: person.role },
    })),
  );
  const themes: CandidateSource[] = themeLists.flatMap(({ keyword, items }) =>
    items.map((item) => ({
      item,
      kind: "theme" as const,
      strength: (keyword.affinity / strongestKeyword) * strengths.theme,
      reason: { kind: "theme" as const, name: keyword.name },
    })),
  );
  const fresh: CandidateSource[] = freshLists.flat().map((item) => ({ item, kind: "fresh" as const, strength: strengths.fresh, reason: { kind: "fresh" as const } }));
  const genreSources: CandidateSource[] = settled(genreLists)
    .flat()
    .map((item) => ({ item, kind: "genre" as const, strength: strengths.genre, reason: { kind: "genre" as const } }));

  return {
    seeds,
    profile,
    extra: [...collections, ...personSources, ...themes, ...fresh, ...genreSources],
    people,
    personLists,
    themes,
    fresh,
    collections,
    genreType,
    genreRequests,
    genreLists,
  };
}

function noteFor(reason: Reason | null): string | undefined {
  if (!reason) return undefined;
  switch (reason.kind) {
    case "similar":
      return reason.title ? t("feed.similarTo", { title: reason.title.title }) : undefined;
    case "collection":
      return reason.title ? t("feed.reason.collection", { title: reason.title.title }) : undefined;
    case "person":
      return reason.name ? t(reason.role === "director" ? "feed.reason.director" : "feed.reason.cast", { name: reason.name }) : undefined;
    case "theme":
      return t("feed.reason.theme");
    case "fresh":
      return t("feed.reason.fresh");
    default:
      return undefined;
  }
}

function becauseTitle(signal: TasteSignal, entry: TrackEntry | undefined): string {
  const title = signal.title.title;
  if (signal.origin === "binged") return t("feed.because.binged", { title });
  if (signal.origin === "finished") return t("feed.because.finished", { title });
  const liked = (entry?.rating ?? 0) >= likedRating || entry?.liked || signal.status === "completed";
  if (liked) return t("feed.because.liked", { title });
  return signal.status === "planned" ? t("feed.because.planned", { title }) : t("feed.because.watching", { title });
}

function personTitle(person: PersonAffinity): string {
  return person.role === "director" ? t("feed.person.director", { name: person.name }) : t("feed.person.cast", { name: person.name });
}

let tunedPreset = defaultPreset;

function currentWeights() {
  return weightPresets[tunedPreset] ?? weightPresets[defaultPreset];
}

async function buildFeed(tracked: Record<string, TrackEntry>, progress: Record<string, Progress>, dismissed: Record<string, Dismissal>): Promise<FeedRow[]> {
  const now = Date.now();
  const signals = tasteSignals(tracked, progress, now);
  const chosen = chooseSeeds(signals, dismissalSignals(dismissed, tracked, now), now, seededRandom(dayNumber(now)));
  const gathered = await gather(chosen);
  if (!gathered) return [];
  const { seeds, profile, extra, people, personLists, themes, fresh, collections, genreType, genreRequests, genreLists } = gathered;

  const known = new Set([...Object.keys(tracked), ...Object.keys(dismissed)]);
  const shown = new Set<string>();
  const unseen = <T extends MediaItem>(items: T[], limit: number): T[] => {
    const seen = new Set<string>();
    return items
      .filter((item) => {
        const itemKey = key(item);
        if (known.has(itemKey) || shown.has(itemKey) || seen.has(itemKey)) return false;
        seen.add(itemKey);
        return true;
      })
      .slice(0, limit);
  };
  const rows: FeedRow[] = [];
  const push = (row: FeedRow, shortest = shortestRow) => {
    if (row.items.length < shortest) return;
    for (const item of row.items) shown.add(key(item));
    rows.push(row);
  };
  const ranked = (sources: CandidateSource[], limit: number) =>
    rankCandidates([], sources, profile, known, limit, currentWeights()).map(({ item, reason }) => ({ ...item, note: noteFor(reason) }));

  const forYou = rankCandidates(seeds, extra, profile, known, forYouLimit, currentWeights());
  push({ id: "for-you", title: t("feed.forYou"), items: unseen(forYou.map(({ item, reason }) => ({ ...item, note: noteFor(reason) })), forYouLimit) });

  if (collections.length > 0) {
    push({ id: "collections", title: t("feed.collections"), items: unseen(ranked(collections, rowLimit), rowLimit) }, shortestCollectionRow);
  }

  const liked = seeds.filter((seed) => seed.signal.weight > 0);
  const strongest = liked[0];
  const latest = [...liked].sort((a, b) => b.signal.at - a.signal.at).find((seed) => seed !== strongest);
  for (const seed of [strongest, latest].filter((seed): seed is Seed => seed !== undefined).slice(0, becauseRowLimit)) {
    const seedKey = key(seed.signal.title);
    push({
      id: `because:${seedKey}`,
      title: becauseTitle(seed.signal, tracked[seedKey]),
      items: unseen(bestRated(seed.source.recommendations, rowWorthyRating), rowLimit),
    });
  }

  if (themes.length > 0) push({ id: "themes", title: t("feed.themes"), items: unseen(ranked(themes, rowLimit + 6), rowLimit) });

  people.forEach((person, index) => {
    push({ id: `person:${person.id}`, title: personTitle(person), items: unseen(bestRated(personLists[index]), rowLimit) });
  });

  if (fresh.length > 0) push({ id: "fresh", title: t("feed.fresh"), items: unseen(ranked(fresh, rowLimit + 6), rowLimit) });

  const genreNames = await tmdb.genreNames().catch(() => new Map<number, string>());
  genreRequests.forEach((request, index) => {
    const result = genreLists[index];
    const name = genreNames.get(request.id) ?? genreNames.get(request.genre);
    if (result.status !== "fulfilled" || !name) return;
    push({ id: `genre:${genreType}:${request.id}`, title: t("feed.genre", { genre: name.toLowerCase() }), items: unseen(result.value, rowLimit) });
  });

  return rows;
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

export async function tuneWeights(): Promise<TuningResult | null> {
  const { tracked, progress, dismissed } = useLibrary.getState();
  const now = Date.now();
  const signals = tasteSignals(tracked, progress, now);
  const positives = signals.filter((signal) => signal.weight >= tuningPositiveWeight);
  if (positives.length < tuningPositives) return null;
  const presets = Object.keys(weightPresets);
  const hits = Object.fromEntries(presets.map((preset) => [preset, 0])) as Record<string, number>;
  let hiddenTotal = 0;
  for (let round = 0; round < tuningRounds; round++) {
    const random = seededRandom(dayNumber(now) * 31 + round + 1);
    const hidden = shuffled(positives, random).slice(0, Math.max(3, Math.round(positives.length * tuningHiddenShare)));
    const hiddenKeys = new Set(hidden.map((signal) => key(signal.title)));
    const visible = signals.filter((signal) => !hiddenKeys.has(key(signal.title)));
    const chosen = chooseSeeds(visible, dismissalSignals(dismissed, tracked, now), now, random);
    const gathered = await gather(chosen);
    if (!gathered) continue;
    const known = new Set([...Object.keys(tracked), ...Object.keys(dismissed)].filter((itemKey) => !hiddenKeys.has(itemKey)));
    for (const preset of presets) {
      const ranked = rankCandidates(gathered.seeds, gathered.extra, gathered.profile, known, tuningDepth, weightPresets[preset]);
      hits[preset] += ranked.filter((entry) => hiddenKeys.has(key(entry.item))).length;
    }
    hiddenTotal += hidden.length;
  }
  if (hiddenTotal === 0) return null;
  const best = presets.reduce((winner, preset) => (hits[preset] > hits[winner] ? preset : winner), defaultPreset);
  const result: TuningResult = { preset: best, hits, hidden: hiddenTotal, testedAt: now };
  const changed = best !== tunedPreset;
  tunedPreset = best;
  useFeed.setState(changed ? { tuning: result, builtAt: 0 } : { tuning: result });
  void backend.storeSet(tuningStore, JSON.stringify(result)).catch(() => undefined);
  return result;
}

interface FeedState {
  rows: FeedRow[] | null;
  signature: string | null;
  builtAt: number;
  building: boolean;
  restored: boolean;
  tuning: TuningResult | null;
}

export const useFeed = create<FeedState>(() => ({ rows: null, signature: null, builtAt: 0, building: false, restored: false, tuning: null }));

let restoring: Promise<void> | null = null;

export function restoreFeed(): Promise<void> {
  return restore();
}

function restore(): Promise<void> {
  restoring ??= Promise.all([
    backend.storeGet(feedStore).catch(() => null),
    backend.storeGet(tuningStore).catch(() => null),
  ]).then(([feed, tuning]) => {
    try {
      const parsedTuning = tuning ? (JSON.parse(tuning.text) as TuningResult) : null;
      if (parsedTuning && weightPresets[parsedTuning.preset]) {
        tunedPreset = parsedTuning.preset;
        useFeed.setState({ tuning: parsedTuning });
      }
    } catch {
      useFeed.setState({ tuning: null });
    }
    try {
      const stored = feed ? (JSON.parse(feed.text) as { signature: string; language: string; builtAt: number; rows: FeedRow[] }) : null;
      if (stored && stored.language === catalogLanguage() && Array.isArray(stored.rows)) {
        useFeed.setState({ rows: stored.rows, signature: stored.signature, builtAt: stored.builtAt });
      }
    } catch {
      useFeed.setState({ rows: null });
    }
    useFeed.setState({ restored: true });
  });
  return restoring;
}

let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
let wantedSignature = "";

async function rebuild(signature: string): Promise<void> {
  if (useFeed.getState().building) return;
  useFeed.setState({ building: true });
  try {
    const { tracked, progress, dismissed } = useLibrary.getState();
    const rows = await buildFeed(tracked, progress, dismissed);
    const builtAt = Date.now();
    useFeed.setState({ rows, signature, builtAt });
    void backend
      .storeSet(feedStore, JSON.stringify({ signature, language: catalogLanguage(), builtAt, rows }))
      .catch(() => undefined);
    const tuning = useFeed.getState().tuning;
    if (!tuning || builtAt - tuning.testedAt > tuningEveryMs) void tuneWeights().catch(() => undefined);
  } catch {
    useFeed.setState({ builtAt: Date.now() });
  } finally {
    useFeed.setState({ building: false });
    if (wantedSignature !== signature) scheduleRebuild(wantedSignature, true);
  }
}

function scheduleRebuild(signature: string, soon: boolean): void {
  wantedSignature = signature;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => void rebuild(signature), soon ? 0 : rebuildDelayMs);
}

export interface PersonalFeed {
  available: boolean;
  rows: FeedRow[] | null;
}

export function usePersonalFeed(): PersonalFeed {
  const tracked = useLibrary((state) => state.tracked);
  const progress = useLibrary((state) => state.progress);
  const loaded = useLibrary((state) => state.loaded);
  const dismissed = useLibrary((state) => state.dismissed);
  const { rows: storedRows, signature: builtSignature, builtAt, restored } = useFeed();
  const signals = useMemo(() => tasteSignals(tracked, progress, Date.now()), [tracked, progress]);
  const signature = useMemo(
    () =>
      [
        catalogLanguage(),
        signals.map((signal) => `${key(signal.title)}=${signal.weight.toFixed(1)}`).join("|"),
        Object.keys(dismissed).sort().join(","),
      ].join("~"),
    [signals, dismissed],
  );

  useEffect(() => {
    void restore();
  }, []);

  useEffect(() => {
    if (!loaded || !restored) return;
    const stale = Date.now() - builtAt > feedMaxAgeMs;
    const changed = builtSignature !== signature;
    if (!changed && !stale) return;
    scheduleRebuild(signature, builtSignature === null);
  }, [signature, loaded, restored, builtSignature, builtAt]);

  const rows = useMemo(
    () =>
      storedRows
        ?.map((row) => ({ ...row, items: row.items.filter((item) => !(key(item) in dismissed) && !(key(item) in tracked)) }))
        .filter((row) => row.items.length > 0) ?? null,
    [storedRows, dismissed, tracked],
  );

  const available = signals.some((signal) => signal.weight > 0);
  return { available, rows };
}
