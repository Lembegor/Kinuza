import { useEffect, useMemo, useState } from "react";
import type { TasteFilters } from "../lib/backend";
import type { MessageKey } from "../lib/i18n";
import { cachedCatalog } from "../lib/persistentCache";
import { key } from "../lib/taste";
import { tmdb, type MediaItem, type MediaType } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { recentDays, shiftDay, type CalendarEpisode } from "./calendar";
import { buildEnginePicks } from "./engineFeed";
import { entryToRef, titleKey, useLibrary, type TitleRef, type TrackEntry } from "./library";

const listMaxAgeMs = 6 * 60 * 60 * 1000;
const digitalDays = 90;
const airingDays = 30;
const moodLimit = 24;

export type MoodId = "all" | "evening" | "binge" | "light" | "tense" | "anime" | "short";

export interface Mood {
  id: MoodId;
  labelKey: MessageKey;
  icon: string;
  filters: TasteFilters;
  fallback: { type: MediaType; genres?: number[]; withoutGenres?: number[]; minRuntime?: number; maxRuntime?: number; anime?: boolean };
}

export const moods: Mood[] = [
  { id: "all", labelKey: "home.mood.all", icon: "", filters: {}, fallback: { type: "movie" } },
  { id: "evening", labelKey: "home.mood.evening", icon: "popcorn", filters: { kind: "movie", anime: false, minRuntime: 80, maxRuntime: 140 }, fallback: { type: "movie", minRuntime: 80, maxRuntime: 140 } },
  { id: "binge", labelKey: "home.mood.binge", icon: "tv", filters: { kind: "tv", anime: false, withoutGenres: [10763, 10764, 10767] }, fallback: { type: "tv", withoutGenres: [16, 10763, 10764, 10767] } },
  { id: "light", labelKey: "home.mood.light", icon: "laugh", filters: { genres: [35], withoutGenres: [27, 53, 10752, 80] }, fallback: { type: "movie", genres: [35], withoutGenres: [27, 53, 10752, 80] } },
  { id: "tense", labelKey: "home.mood.tense", icon: "zap", filters: { genres: [53] }, fallback: { type: "movie", genres: [53, 27, 9648] } },
  { id: "anime", labelKey: "home.mood.anime", icon: "sparkles", filters: { anime: true }, fallback: { type: "tv", anime: true } },
  { id: "short", labelKey: "home.mood.short", icon: "timer", filters: { kind: "movie", maxRuntime: 95 }, fallback: { type: "movie", maxRuntime: 95 } },
];

export function moodOf(id: string | null): Mood {
  return moods.find((mood) => mood.id === id) ?? moods[0];
}

export interface PickItem extends MediaItem {
  note?: string;
}

function knownKeys(): Set<string> {
  const { tracked, progress, dismissed } = useLibrary.getState();
  return new Set([...Object.keys(tracked), ...Object.keys(dismissed), ...Object.values(progress).map((item) => titleKey(item.title.type, item.title.id))]);
}

const moodCache = new Map<string, Promise<PickItem[]>>();

export function moodPicks(mood: Mood, limit = moodLimit): Promise<PickItem[]> {
  const cacheKey = `${mood.id}:${limit}`;
  let known = moodCache.get(cacheKey);
  if (!known) {
    known = loadMood(mood, limit).catch((error) => {
      moodCache.delete(cacheKey);
      throw error;
    });
    moodCache.set(cacheKey, known);
  }
  return known;
}

export function forgetMoodPicks(): void {
  moodCache.clear();
}

async function loadMood(mood: Mood, limit: number): Promise<PickItem[]> {
  const { tracked, progress, dismissed } = useLibrary.getState();
  const engine = await buildEnginePicks(tracked, progress, dismissed, mood.filters, limit).catch(() => null);
  if (engine && engine.length > 0) return engine;
  const { type, ...rest } = mood.fallback;
  const found = await cachedCatalog(`mood:${mood.id}`, listMaxAgeMs, () => tmdb.moodList(type, rest));
  const skip = knownKeys();
  return found.filter((item) => item.poster && !skip.has(key(item))).slice(0, limit);
}

export function useMoodPicks(mood: Mood, enabled: boolean, generation = 0): { items: PickItem[] | null; error: boolean } {
  const dismissed = useLibrary((state) => state.dismissed);
  const tracked = useLibrary((state) => state.tracked);
  const [state, setState] = useState<{ id: string; items: PickItem[] | null; error: boolean }>({ id: "", items: null, error: false });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState({ id: mood.id, items: null, error: false });
    moodPicks(mood).then(
      (items) => alive && setState({ id: mood.id, items, error: false }),
      () => alive && setState({ id: mood.id, items: [], error: true }),
    );
    return () => {
      alive = false;
    };
  }, [mood, enabled, generation]);
  const items = useMemo(
    () => (state.id === mood.id ? (state.items?.filter((item) => !(key(item) in dismissed) && !(key(item) in tracked)) ?? null) : null),
    [state, mood.id, dismissed, tracked],
  );
  return { items, error: state.error };
}

export async function surprisePick(mood: Mood, avoid: Set<string>, shown: PickItem[] | null): Promise<PickItem | null> {
  const list = shown && shown.length > 0 ? shown : await moodPicks(mood).catch(() => [] as PickItem[]);
  const { tracked, dismissed } = useLibrary.getState();
  const pool = list.filter((item) => item.poster && !avoid.has(key(item)) && !(key(item) in tracked) && !(key(item) in dismissed));
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

export type FreshTab = "forYou" | "movies" | "series" | "anime";
export type PopularTab = "all" | "movies" | "series" | "anime";

const freshLoaders: Record<Exclude<FreshTab, "forYou">, () => Promise<MediaItem[]>> = {
  movies: () => cachedCatalog("home:digital", listMaxAgeMs, () => tmdb.digitalMovies(digitalDays)),
  series: () => cachedCatalog("home:airing", listMaxAgeMs, () => tmdb.airingSeries(airingDays, false)),
  anime: () => cachedCatalog("home:airing-anime", listMaxAgeMs, () => tmdb.airingSeries(airingDays, true)),
};

const popularLoaders: Record<PopularTab, () => Promise<MediaItem[]>> = {
  all: () => cachedCatalog("home:trending", listMaxAgeMs, tmdb.trending),
  movies: () => cachedCatalog("home:trending-movies", listMaxAgeMs, tmdb.trendingMovies),
  series: () => cachedCatalog("home:trending-series", listMaxAgeMs, tmdb.popularSeries),
  anime: () => cachedCatalog("home:anime", listMaxAgeMs, tmdb.anime),
};

export type BestTab = "movies" | "series";

const bestLoaders: Record<BestTab, () => Promise<MediaItem[]>> = {
  movies: () => cachedCatalog("home:top-movies", listMaxAgeMs, tmdb.topMovies),
  series: () => cachedCatalog("home:top-series", listMaxAgeMs, tmdb.topSeries),
};

export function useBestList(tab: BestTab) {
  return useAsync(() => bestLoaders[tab](), [tab], `home-best:${tab}`);
}

export function useFreshList(tab: Exclude<FreshTab, "forYou">, enabled: boolean) {
  return useAsync(() => (enabled ? freshLoaders[tab]() : Promise.resolve([] as MediaItem[])), [tab, enabled], enabled ? `home-fresh:${tab}` : undefined);
}

export function usePopularList(tab: PopularTab, enabled: boolean) {
  return useAsync(() => (enabled ? popularLoaders[tab]() : Promise.resolve([] as MediaItem[])), [tab, enabled], enabled ? `home-popular:${tab}` : undefined);
}

export function loadDigitalMovies(): Promise<MediaItem[]> {
  return freshLoaders.movies();
}

export type PlannedReason = { kind: "season"; season: number } | { kind: "episode" } | { kind: "premiere" } | { kind: "digital" } | { kind: "added"; at: number };

export interface PlannedItem extends TitleRef {
  reason: PlannedReason;
  fresh: boolean;
  sortAt: number;
}

export function plannedItems(tracked: Record<string, TrackEntry>, episodes: CalendarEpisode[] | null, digital: MediaItem[] | null, today: string): PlannedItem[] {
  const since = shiftDay(today, -recentDays);
  const latest = new Map<number, CalendarEpisode>();
  for (const episode of episodes ?? []) {
    if (episode.airDate < since || episode.airDate > today) continue;
    const known = latest.get(episode.title.id);
    if (!known || episode.airDate > known.airDate) latest.set(episode.title.id, episode);
  }
  const digitalKeys = new Set((digital ?? []).map((item) => key(item)));
  return Object.values(tracked)
    .filter((entry) => entry.status === "planned")
    .map((entry): PlannedItem => {
      const ref = entryToRef(entry);
      const aired = entry.type === "tv" ? latest.get(entry.id) : undefined;
      if (aired) {
        const reason: PlannedReason = aired.episode === 1 ? (aired.season > 1 ? { kind: "season", season: aired.season } : { kind: "premiere" }) : { kind: "episode" };
        return { ...ref, reason, fresh: true, sortAt: Date.parse(aired.airDate) || entry.updatedAt };
      }
      if (entry.type === "movie" && digitalKeys.has(titleKey("movie", entry.id))) return { ...ref, reason: { kind: "digital" }, fresh: true, sortAt: entry.updatedAt };
      return { ...ref, reason: { kind: "added", at: entry.addedAt }, fresh: false, sortAt: entry.updatedAt };
    })
    .sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.sortAt - a.sortAt);
}
