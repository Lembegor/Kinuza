import { useMemo } from "react";
import { tmdb, type Episode } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { localDay } from "./calendar";
import { entryToRef, isWatched, titleKey, unitKey, useLibrary, type Progress, type TitleRef, type TrackEntry } from "./library";

const specialsSeason = 0;
const upNextLimit = 12;
const minStartedSeconds = 30;
const skippedStatuses = new Set(["dropped", "completed", "onHold"]);

export interface UpNextEpisode {
  title: TitleRef;
  unitKey: string;
  season: number;
  episode: number;
  name: string;
  still: string | null;
  lastActivity: number;
}

interface SeriesPlace {
  title: TitleRef;
  season: number;
  episode: number;
  lastActivity: number;
}

function isLater(a: { season: number; episode: number }, b: { season: number; episode: number }): boolean {
  return a.season > b.season || (a.season === b.season && a.episode > b.episode);
}

export function seriesToContinue(progress: Record<string, Progress>, tracked: Record<string, TrackEntry>): SeriesPlace[] {
  const furthest = new Map<number, SeriesPlace & { watchedAt: number }>();
  const lastActivity = new Map<number, number>();
  const startedAt = new Map<number, number>();
  for (const item of Object.values(progress)) {
    if (item.title.type !== "tv" || item.season === undefined || item.episode === undefined || item.season === specialsSeason) continue;
    const id = item.title.id;
    lastActivity.set(id, Math.max(lastActivity.get(id) ?? 0, item.updatedAt));
    if (!isWatched(item)) {
      if (item.position >= minStartedSeconds) startedAt.set(id, Math.max(startedAt.get(id) ?? 0, item.updatedAt));
      continue;
    }
    const place = { season: item.season, episode: item.episode };
    const known = furthest.get(id);
    if (!known || isLater(place, known)) {
      const entry = tracked[titleKey("tv", id)];
      furthest.set(id, { title: entry ? entryToRef(entry) : item.title, ...place, lastActivity: 0, watchedAt: item.updatedAt });
    }
  }
  const places: SeriesPlace[] = [];
  for (const [id, place] of furthest) {
    const status = tracked[titleKey("tv", id)]?.status;
    if (status && skippedStatuses.has(status)) continue;
    if ((startedAt.get(id) ?? 0) >= place.watchedAt) continue;
    places.push({ title: place.title, season: place.season, episode: place.episode, lastActivity: lastActivity.get(id) ?? place.watchedAt });
  }
  return places.sort((a, b) => b.lastActivity - a.lastActivity).slice(0, upNextLimit);
}

async function seasonOrEmpty(seriesId: number, season: number): Promise<Episode[]> {
  return tmdb.season(seriesId, season).catch(() => []);
}

async function nextEpisodeAfter(place: SeriesPlace, today: string): Promise<UpNextEpisode | null> {
  const progress = useLibrary.getState().progress;
  const unwatched = (episode: Episode) =>
    episode.airDate !== "" && episode.airDate <= today && !isWatched(progress[unitKey("tv", place.title.id, episode.season, episode.episode)]);
  const current = await seasonOrEmpty(place.title.id, place.season);
  let next = current.filter((episode) => episode.episode > place.episode).sort((a, b) => a.episode - b.episode)[0];
  if (!next) {
    const following = await seasonOrEmpty(place.title.id, place.season + 1);
    next = following.sort((a, b) => a.episode - b.episode)[0];
  }
  if (!next || !unwatched(next)) return null;
  return {
    title: place.title,
    unitKey: unitKey("tv", place.title.id, next.season, next.episode),
    season: next.season,
    episode: next.episode,
    name: next.name,
    still: next.still,
    lastActivity: place.lastActivity,
  };
}

async function upNext(places: SeriesPlace[], today: string): Promise<UpNextEpisode[]> {
  const found = await Promise.all(places.map((place) => nextEpisodeAfter(place, today).catch(() => null)));
  return found.filter((item): item is UpNextEpisode => item !== null);
}

export function useUpNext(): UpNextEpisode[] | null {
  const progress = useLibrary((state) => state.progress);
  const tracked = useLibrary((state) => state.tracked);
  const places = useMemo(() => seriesToContinue(progress, tracked), [progress, tracked]);
  const today = localDay(new Date());
  const signature = places.map((place) => `${place.title.id}:${place.season}:${place.episode}`).join(",");
  const result = useAsync(() => upNext(places, today), [signature, today]);
  return result.data ?? (result.loading ? null : []);
}
