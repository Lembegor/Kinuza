import { useMemo } from "react";
import { tmdb, type AiringEpisode } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { entryToRef, isWatched, titleKey, unitKey, useLibrary, type Progress, type TitleRef, type TrackEntry, type WatchStatus } from "./library";

export const recentDays = 14;
const upcomingDays = 90;
const catalogConcurrency = 6;
const followedStatuses: ReadonlySet<WatchStatus> = new Set<WatchStatus>(["watching", "planned"]);

export interface CalendarEpisode {
  title: TitleRef;
  poster: string | null;
  season: number;
  episode: number;
  name: string;
  airDate: string;
}

export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dayToDate(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

export function shiftDay(day: string, days: number): string {
  const date = dayToDate(day);
  date.setDate(date.getDate() + days);
  return localDay(date);
}

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

async function seriesEpisodes(title: TitleRef, from: string, to: string): Promise<CalendarEpisode[]> {
  const airing = await tmdb.airing(title.id);
  const inSpan = (episode: AiringEpisode | null): episode is AiringEpisode =>
    episode !== null && episode.airDate !== "" && episode.airDate >= from && episode.airDate <= to;
  const anchors = [airing.last, airing.next].filter(inSpan);
  const seasons = [...new Set(anchors.map((episode) => episode.season))];
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
    .map(({ season, episode, name, airDate }) => ({ title, poster: airing.seasonPosters[season] ?? title.poster, season, episode, name, airDate }));
}

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

export function isNewEpisode(episode: CalendarEpisode, progress: Record<string, Progress>, today: string): boolean {
  return episode.airDate <= today && !isEpisodeWatched(episode, progress);
}

export async function newEpisodes(): Promise<CalendarEpisode[]> {
  const { tracked, progress } = useLibrary.getState();
  const today = localDay(new Date());
  const schedule = await episodeSchedule(followedSeries(tracked, progress), today);
  const current = useLibrary.getState().progress;
  return schedule.filter((episode) => isNewEpisode(episode, current, today));
}

export interface EpisodeCalendar {
  today: string;
  followed: number;
  episodes: CalendarEpisode[] | null;
  error: unknown;
  reload: () => void;
}

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
