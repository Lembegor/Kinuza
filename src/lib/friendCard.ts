import { isRecord } from "./account";
import { isAdultTitle } from "./adultTitles";
import { allTime, buildHistory, dayKey, overview, sinceDate, type HistoryItem, type Kind, type Ledger, type Overview } from "./profileStats";
import { watchedEpisodeCount, type Progress, type TrackEntry } from "../state/library";

export const friendCardVersion = 1;
const heatDays = 371;
const sideLimit = 6;
const topLimit = 10;
const listLimit = 10;
const recentLimit = 12;
const episodeLimit = 40;

export interface CardTitle {
  key: string;
  name: string;
  poster: string | null;
}

export interface CardWatching extends CardTitle {
  movie: boolean;
  share: number;
  watched: number;
  total: number;
}

export interface CardTop extends CardTitle {
  kind: Kind;
  seconds: number;
}

export interface CardRecent extends Omit<HistoryItem, "eventIds"> {
  poster: string | null;
}

export type CardOverview = Omit<Overview, "days" | "first" | "last"> & { days: [string, number][] };

export interface CardAchievement {
  id: string;
  tier: number;
}

export interface FriendCard {
  achievements?: CardAchievement[];
  v: number;
  at: number;
  since: number | null;
  titles: number;
  cover: string | null;
  completedSeries: number;
  overview: CardOverview;
  watching: CardWatching[];
  top: CardTop[];
  recent: CardRecent[];
}

export interface CardInput {
  ledger: Ledger;
  tracked: Record<string, TrackEntry>;
  progress: Record<string, Progress>;
  onboardedAt: number | undefined;
  cover: string | null;
  now: number;
  achievements?: CardAchievement[];
}

function shareable(key: string): boolean {
  const [type, id] = key.split(":");
  return !isAdultTitle(type, Number(id));
}

function posterOf(tracked: Record<string, TrackEntry>, key: string): string | null {
  return tracked[key]?.poster ?? null;
}

export function buildFriendCard({ ledger, tracked, progress, onboardedAt, cover, now, achievements }: CardInput): FriendCard {
  const data = overview(ledger, allTime, null, now);
  const oldest = dayKey(now - heatDays * 86_400_000);
  const days = [...data.days.entries()].filter(([day]) => day >= oldest).sort(([a], [b]) => a.localeCompare(b));
  const { days: _days, first: _first, last: _last, ...all } = data;
  const rest = {
    ...all,
    top: all.top.filter((item) => shareable(item.key)),
    recordDay: all.recordDay && shareable(all.recordDay.key) ? all.recordDay : null,
  };
  const watching = Object.entries(tracked)
    .filter(([key, entry]) => entry.status === "watching" && shareable(key))
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, sideLimit)
    .map(([key, entry]): CardWatching => {
      if (key.startsWith("movie:")) {
        const unit = progress[key];
        const share = unit && unit.duration > 1 ? Math.min(1, unit.position / unit.duration) : 0;
        return { key, name: entry.title, poster: entry.poster, movie: true, share, watched: 0, total: 0 };
      }
      const watched = watchedEpisodeCount(progress, entry.id);
      const total = entry.totalEpisodes ?? 0;
      return { key, name: entry.title, poster: entry.poster, movie: false, share: total > 0 ? Math.min(1, watched / total) : 0, watched, total };
    });
  const recent = buildHistory(ledger, { kind: null, finishedOnly: false, key: null })
    .filter((day) => day.day !== null)
    .flatMap((day) => day.items)
    .filter((item) => shareable(item.key))
    .slice(0, recentLimit)
    .map(({ eventIds: _eventIds, ...item }): CardRecent => ({ ...item, episodes: item.episodes.slice(0, episodeLimit), poster: posterOf(tracked, item.key) }));
  return {
    ...(achievements && achievements.length > 0 ? { achievements } : {}),
    v: friendCardVersion,
    at: now,
    since: sinceDate(ledger.input, onboardedAt),
    titles: Object.keys(tracked).length,
    cover: cover ? (tracked[cover]?.backdrop ?? null) : null,
    completedSeries: Object.entries(tracked).filter(([key, entry]) => key.startsWith("tv:") && entry.status === "completed").length,
    overview: {
      ...rest,
      days,
      top: rest.top.slice(0, topLimit),
      genres: rest.genres.slice(0, listLimit),
      languages: rest.languages.slice(0, listLimit),
      habits: rest.habits ? { ...rest.habits, voices: rest.habits.voices.slice(0, 5) } : null,
    },
    watching,
    top: rest.top.slice(0, sideLimit).map((item) => ({ key: item.key, name: item.name, kind: item.kind, seconds: item.seconds, poster: posterOf(tracked, item.key) })),
    recent,
  };
}

export function cardSignature(card: FriendCard): string {
  const { at: _at, ...rest } = card;
  return JSON.stringify(rest);
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function readFriendCard(value: unknown): { card: FriendCard; overview: Overview } | null {
  if (!isRecord(value) || value.v !== friendCardVersion || !isRecord(value.overview)) return null;
  const raw = value.overview as Record<string, unknown>;
  if (typeof raw.seconds !== "number" || !isRecord(raw.byKind) || !isRecord(raw.rating)) return null;
  const days = new Map<string, number>(list<[string, number]>(raw.days).filter((pair) => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "number"));
  const restored = {
    ...(raw as unknown as CardOverview),
    days,
    months: list(raw.months),
    genres: list(raw.genres),
    decades: list(raw.decades),
    languages: list(raw.languages),
    top: list(raw.top),
    first: null,
    last: null,
  } as Overview;
  const card: FriendCard = {
    achievements: list<CardAchievement>(value.achievements).filter(
      (item) => isRecord(item) && typeof item.id === "string" && typeof item.tier === "number" && item.tier > 0,
    ),
    v: friendCardVersion,
    at: typeof value.at === "number" ? value.at : 0,
    since: typeof value.since === "number" ? value.since : null,
    titles: typeof value.titles === "number" ? value.titles : 0,
    cover: typeof value.cover === "string" ? value.cover : null,
    completedSeries: typeof value.completedSeries === "number" ? value.completedSeries : 0,
    overview: value.overview as unknown as CardOverview,
    watching: list<CardWatching>(value.watching).filter((item) => isRecord(item) && typeof item.key === "string"),
    top: list<CardTop>(value.top).filter((item) => isRecord(item) && typeof item.key === "string"),
    recent: list<CardRecent>(value.recent)
      .filter((item) => isRecord(item) && typeof item.key === "string" && Array.isArray(item.episodes))
      .map((item) => ({ ...item })),
  };
  return { card, overview: restored };
}
