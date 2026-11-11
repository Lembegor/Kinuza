// The episode calendar: what the series the user follows aired lately and what they air next.

import { useMemo } from "react";
import { tmdb, type AiringEpisode } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { entryToRef, isWatched, titleKey, unitKey, useLibrary, type Progress, type TitleRef, type TrackEntry, type WatchStatus } from "./library";

/** How many days back an aired episode stays on the calendar, and stays "new" while it is unwatched. */
export const recentDays = 14;
/** How many days ahead the calendar looks. */
const upcomingDays = 90;
/** Catalog requests in flight at once: a long list of series must not flood the catalog. */
const catalogConcurrency = 6;
/** Statuses that mean "tell me when an episode comes out", whether or not anything was watched yet. */
const followedStatuses: ReadonlySet<WatchStatus> = new Set<WatchStatus>(["watching", "planned"]);

export interface CalendarEpisode {
  title: TitleRef;
  season: number;
  episode: number;
  name: string;
  /** The day it airs, as the catalog writes dates: "2026-11-11". */
  airDate: string;
}

/** The calendar day in the user's time zone, in the catalog's date format. */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A catalog date as a moment of the user's own day; `new Date("2026-11-11")` would be midnight in UTC instead. */
export function dayToDate(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

export function shiftDay(day: string, days: number): string {
  const date = dayToDate(day);
  date.setDate(date.getDate() + days);
  return localDay(date);
}

/**
 * The series whose episodes the user wants to hear about: those being watched or planned, and
 * any other series they have started, unless they dropped it.
 */
export function followedSeries(tracked: Record<string, TrackEntry>, progress: Record<string, Progress>): TitleRef[] {
  const series = new Map<number, TitleRef>();
  for (const entry of Object.values(tracked)) {
    if (entry.type === "tv" && entry.status && followedStatuses.has(entry.status)) series.set(entry.id, entryToRef(entry));
  }
  for (const { title } of Object.values(progress)) {
    if (title.type !== "tv" || series.has(title.id)) continue;
    const entry = tracked[titleKey("tv", title.id)];
    if (entry?.status === "dropped") continue;
    series.set(title.id, entry ? entryToRef(entry) : title);
  }
  return [...series.values()];
}

/** Runs `task` over `items`, `limit` at a time; a failure is kept as a rejection and does not stop the rest. */
async function settleInTurn<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** One series' episodes that air from `from` to `to`. A series with nothing dated in that span costs one request. */
async function seriesEpisodes(title: TitleRef, from: string, to: string): Promise<CalendarEpisode[]> {
  const airing = await tmdb.airing(title.id);
  // An episode without a date is announced but not scheduled; there is no day to put it on.
  const inSpan = (episode: AiringEpisode | null): episode is AiringEpisode =>
    episode !== null && episode.airDate !== "" && episode.airDate >= from && episode.airDate <= to;
  const anchors = [airing.last, airing.next].filter(inSpan);
  const seasons = [...new Set(anchors.map((episode) => episode.season))];
  // The series itself names only its last and next episode; the season's list has the ones around
  // them. If the list cannot be had, those two are still worth showing.
  const lists = await Promise.all(
    seasons.map((season) =>
      tmdb.season(title.id, season).then(
        (episodes): AiringEpisode[] => episodes,
        () => anchors.filter((episode) => episode.season === season),
      ),
    ),
  );
  return lists
    .flat()
    .filter(inSpan)
    .map(({ season, episode, name, airDate }) => ({ title, season, episode, name, airDate }));
}

/**
 * Episodes of `series` from `recentDays` before `today` to `upcomingDays` after it, earliest first.
 * The catalog client caches every answer, so asking again costs nothing. Fails only when the
 * catalog could not be reached for any of the series.
 */
export async function episodeSchedule(series: TitleRef[], today: string): Promise<CalendarEpisode[]> {
  const from = shiftDay(today, -recentDays);
  const to = shiftDay(today, upcomingDays);
  const results = await settleInTurn(series, catalogConcurrency, (title) => seriesEpisodes(title, from, to));
  const failure = results.find((result) => result.status === "rejected");
  if (failure && results.every((result) => result.status === "rejected")) throw failure.reason;
  return results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort(
      (a, b) =>
        a.airDate.localeCompare(b.airDate) || a.title.title.localeCompare(b.title.title) || a.season - b.season || a.episode - b.episode,
    );
}

export function isEpisodeWatched(episode: CalendarEpisode, progress: Record<string, Progress>): boolean {
  return isWatched(progress[unitKey("tv", episode.title.id, episode.season, episode.episode)]);
}

/** Out already (the schedule reaches only `recentDays` back) and not watched. */
export function isNewEpisode(episode: CalendarEpisode, progress: Record<string, Progress>, today: string): boolean {
  return episode.airDate <= today && !isEpisodeWatched(episode, progress);
}

/**
 * Episodes of the followed series that came out in the last `recentDays` days and are not watched
 * yet, earliest first. For whoever wants to tell the user about them; call it once the library is loaded.
 */
export async function newEpisodes(): Promise<CalendarEpisode[]> {
  const { tracked, progress } = useLibrary.getState();
  const today = localDay(new Date());
  const schedule = await episodeSchedule(followedSeries(tracked, progress), today);
  // Read again: the catalog takes a moment, and an episode may have been watched meanwhile.
  const current = useLibrary.getState().progress;
  return schedule.filter((episode) => isNewEpisode(episode, current, today));
}

export interface EpisodeCalendar {
  today: string;
  /** How many series the calendar is about; with none there is nothing to wait for. */
  followed: number;
  /** Null until the first answer; after that the last known schedule stays while a newer one loads. */
  episodes: CalendarEpisode[] | null;
  error: unknown;
  reload: () => void;
}

/** The schedule for the series the user follows now. It is asked for again only when that set or the day changes. */
export function useEpisodeCalendar(): EpisodeCalendar {
  const tracked = useLibrary((state) => state.tracked);
  const progress = useLibrary((state) => state.progress);
  const loaded = useLibrary((state) => state.loaded);
  const series = useMemo(() => followedSeries(tracked, progress), [tracked, progress]);
  const today = localDay(new Date());
  const signature = series
    .map((title) => title.id)
    .sort((a, b) => a - b)
    .join(",");
  const schedule = useAsync(() => episodeSchedule(series, today), [signature, today]);
  return {
    today,
    followed: series.length,
    episodes: schedule.data ?? (schedule.loading || !loaded ? null : []),
    error: schedule.error,
    reload: schedule.reload,
  };
}
