import type { ActivityEvent } from "../state/activity";
import type { Progress, TrackEntry } from "../state/library";
import type { MonthTotals } from "../state/profile";
import type { TitlePreferences } from "./account";

export type Kind = "movie" | "tv" | "anime";
export const kinds: Kind[] = ["movie", "tv", "anime"];

export interface TitleInfo {
  anime: boolean;
  genres: number[];
  language: string;
  vote: number;
  year: number;
}

export interface StatsInput {
  tracked: Record<string, TrackEntry>;
  progress: Record<string, Progress>;
  preferences: Record<string, TitlePreferences>;
  events: ActivityEvent[];
  info: Map<string, TitleInfo>;
  hidden: Record<string, number>;
  archive: Record<string, MonthTotals>;
  journalSince: number | null;
}

export type EntrySource = "play" | "finish" | "mark" | "progress" | "status" | "rewatch";

export interface LedgerEntry {
  key: string;
  unit: string;
  kind: Kind;
  name: string;
  year: string;
  at: number | null;
  approximate: boolean;
  seconds: number;
  estimated: boolean;
  finish: boolean;
  rewatch: boolean;
  episodes: number;
  season?: number;
  episode?: number;
  source: EntrySource;
  eventIds: string[];
  intro: number;
  audio?: string;
  subtitles?: boolean;
  missingRuntime: boolean;
}

export interface Ledger {
  entries: LedgerEntry[];
  input: StatsInput;
}

export interface Period {
  from: number | null;
  to: number | null;
}

export const allTime: Period = { from: null, to: null };

const dayMs = 86_400_000;
const watchedShare = 0.92;
const earlierShare = 0.5;
const markWindowMs = 3 * dayMs;
const sessionGapMs = 12 * 3_600_000;
const batchLimit = 5;
const importGapMs = dayMs;
const leastHabitSessions = 10;
const leastRatings = 5;
const leastDropped = 3;
const topLimit = 10;
const tvGenreTwins: Record<number, number[]> = { 10759: [28, 12], 10765: [878, 14], 10768: [10752], 10762: [10751] };

interface EventTitle {
  type?: string;
  id?: number;
  name?: string;
  year?: string;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function keyOfUnit(unit: string): string {
  const parts = unit.split(":");
  return `${parts[0]}:${parts[1]}`;
}

function unitParts(unit: string): { season?: number; episode?: number } {
  const parts = unit.split(":");
  if (parts[0] !== "tv" || parts.length < 4) return {};
  return { season: Number(parts[2]), episode: Number(parts[3]) };
}

function eventKey(event: ActivityEvent): string | null {
  const title = event.title as EventTitle | undefined;
  if (!title || (title.type !== "movie" && title.type !== "tv") || typeof title.id !== "number") return null;
  return `${title.type}:${title.id}`;
}

function isWatched(progress: Progress | undefined): boolean {
  return Boolean(progress && progress.duration > 0 && progress.position / progress.duration >= watchedShare);
}

export function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function monthKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function kindOf(key: string, info: Map<string, TitleInfo>): Kind {
  if (info.get(key)?.anime) return "anime";
  return key.startsWith("movie:") ? "movie" : "tv";
}

export function buildLedger(input: StatsInput): Ledger {
  const { tracked, progress, events, info, hidden, journalSince } = input;
  const entries: LedgerEntry[] = [];
  const names = new Map<string, { name: string; year: string }>();
  const covered = new Set<string>();
  const playsByUnit = new Map<string, ActivityEvent[]>();
  const statusEvents = new Map<string, number[]>();

  for (const event of events) {
    const key = eventKey(event);
    if (!key) continue;
    const title = event.title as EventTitle;
    if (!names.has(key) && title.name) names.set(key, { name: title.name, year: title.year ?? "" });
    if (event.type === "play" && typeof event.unit === "string") {
      const list = playsByUnit.get(event.unit) ?? [];
      list.push(event);
      playsByUnit.set(event.unit, list);
    }
    if (event.type === "list.add" || event.type === "status") {
      const list = statusEvents.get(key) ?? [];
      list.push(event.at);
      statusEvents.set(key, list);
    }
  }

  for (const list of playsByUnit.values()) list.sort((a, b) => a.at - b.at);

  const nameOf = (key: string, fallback?: { name: string; year: string }) => {
    const entry = tracked[key];
    if (entry?.title) return { name: entry.title, year: entry.year };
    return names.get(key) ?? fallback ?? { name: "", year: "" };
  };

  const runtimeOf = (unit: string): number | null => {
    const known = progress[unit];
    if (known && known.duration > 1) return known.duration;
    const minutes = tracked[keyOfUnit(unit)]?.runtime;
    return minutes && minutes > 0 ? minutes * 60 : null;
  };

  const push = (key: string, unit: string, fields: Partial<LedgerEntry> & Pick<LedgerEntry, "at" | "seconds" | "source">) => {
    const label = nameOf(key);
    entries.push({
      key,
      unit,
      kind: kindOf(key, info),
      name: label.name,
      year: label.year,
      approximate: false,
      estimated: false,
      finish: false,
      rewatch: false,
      episodes: 0,
      eventIds: [],
      intro: 0,
      missingRuntime: false,
      ...unitParts(unit),
      ...fields,
    });
  };

  for (const event of events) {
    if (typeof event.unit !== "string") continue;
    const unit = event.unit;
    const key = keyOfUnit(unit);
    if (hidden[key]) continue;
    const tv = key.startsWith("tv:");
    if (event.type === "play") {
      covered.add(unit);
      push(key, unit, {
        at: event.at,
        seconds: num(event.seconds),
        source: "play",
        eventIds: [event.id],
        intro: num(event.intro),
        audio: typeof event.audio === "string" ? event.audio : undefined,
        subtitles: event.subtitles === true,
      });
      continue;
    }
    if (event.type !== "watched") continue;
    covered.add(unit);
    if (event.marked !== true) {
      const started = (playsByUnit.get(unit) ?? []).filter((play) => play.at <= event.at && event.at - play.at <= sessionGapMs).at(-1);
      push(key, unit, { at: started?.at ?? event.at, seconds: 0, source: "finish", finish: true, episodes: tv ? 1 : 0, eventIds: [event.id] });
      continue;
    }
    const runtime = runtimeOf(unit);
    const recent = (playsByUnit.get(unit) ?? []).filter((play) => play.at <= event.at && event.at - play.at <= markWindowMs);
    const measured = recent.reduce((sum, play) => sum + num(play.seconds), 0);
    const length = num(event.length) || runtime || 0;
    const earlier = typeof event.earlier === "boolean" ? event.earlier : !(length > 0 && measured >= length * earlierShare);
    const seenAt = typeof event.seenAt === "number" ? event.seenAt : null;
    if (earlier) {
      push(key, unit, {
        at: seenAt,
        seconds: runtime ?? 0,
        estimated: true,
        finish: true,
        episodes: tv ? 1 : 0,
        source: "mark",
        eventIds: [event.id],
        missingRuntime: runtime === null,
      });
    } else {
      const extra = runtime ? Math.max(0, runtime - measured) : 0;
      push(key, unit, {
        at: seenAt ?? event.at,
        seconds: extra,
        estimated: extra > 0,
        finish: true,
        episodes: tv ? 1 : 0,
        source: "mark",
        eventIds: [event.id],
        missingRuntime: runtime === null && measured === 0,
      });
    }
  }

  const markBatches = new Map<string, number>();
  const batchOf = (unit: string, item: Progress) => `${keyOfUnit(unit)}|${Math.floor((item.updatedAt ?? 0) / 60_000)}`;
  for (const [unit, item] of Object.entries(progress)) {
    if (covered.has(unit) || item.duration > 1) continue;
    markBatches.set(batchOf(unit, item), (markBatches.get(batchOf(unit, item)) ?? 0) + 1);
  }

  for (const [unit, item] of Object.entries(progress)) {
    if (covered.has(unit)) continue;
    const key = keyOfUnit(unit);
    if (hidden[key]) continue;
    if (journalSince !== null && (item.updatedAt ?? 0) >= journalSince) continue;
    const finished = isWatched(item);
    const marked = item.duration <= 1;
    let seconds = item.played ?? 0;
    let estimated = false;
    let missing = false;
    if (!seconds && finished && !marked) seconds = item.duration;
    if (!seconds && !finished && !marked) seconds = item.position;
    if (!seconds && marked && finished) {
      const runtime = runtimeOf(unit);
      seconds = runtime ?? 0;
      estimated = true;
      missing = runtime === null;
    }
    if (seconds <= 0 && !finished) continue;
    const batch = marked && (markBatches.get(batchOf(unit, item)) ?? 0) > batchLimit;
    push(key, unit, {
      at: batch ? null : item.updatedAt || null,
      approximate: !batch,
      seconds,
      estimated,
      finish: finished,
      episodes: finished && key.startsWith("tv:") ? 1 : 0,
      source: "progress",
      missingRuntime: missing,
    });
  }

  const finishedKeys = new Set(entries.filter((entry) => entry.finish).map((entry) => entry.key));
  const statusOnly = Object.entries(tracked).filter(([key, entry]) => !hidden[key] && entry.status === "completed" && !finishedKeys.has(key));
  const addedPerDay = new Map<string, number>();
  for (const [, entry] of statusOnly) addedPerDay.set(dayKey(entry.addedAt), (addedPerDay.get(dayKey(entry.addedAt)) ?? 0) + 1);
  for (const [key, entry] of statusOnly) {
    const movie = key.startsWith("movie:");
    const minutes = entry.runtime && entry.runtime > 0 ? entry.runtime : 0;
    const episodes = movie ? 0 : (entry.totalEpisodes ?? 0);
    const seconds = movie ? minutes * 60 : episodes * minutes * 60;
    const marks = statusEvents.get(key) ?? [];
    const bulk = (addedPerDay.get(dayKey(entry.addedAt)) ?? 0) > batchLimit;
    let at: number | null = entry.finishedAt ?? null;
    if (at === null && !bulk && (journalSince === null || entry.addedAt < journalSince)) at = entry.addedAt;
    else if (at === null && !bulk && marks.some((time) => time > entry.addedAt + importGapMs)) at = entry.addedAt;
    push(key, movie ? key : `${key}:all`, {
      at,
      approximate: at !== null,
      seconds,
      estimated: true,
      finish: true,
      episodes,
      source: "status",
      missingRuntime: seconds === 0,
    });
  }

  const movieFinishes = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    if (!entry.finish || entry.kind === "tv" || !entry.key.startsWith("movie:")) continue;
    const list = movieFinishes.get(entry.key) ?? [];
    list.push(entry);
    movieFinishes.set(entry.key, list);
  }
  for (const list of movieFinishes.values()) {
    list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    list.slice(1).forEach((entry) => (entry.rewatch = true));
  }
  for (const [key, entry] of Object.entries(tracked)) {
    if (hidden[key] || !key.startsWith("movie:") || !entry.rewatches) continue;
    const known = movieFinishes.get(key)?.length ?? 0;
    const extra = Math.max(0, 1 + entry.rewatches - Math.max(1, known)) + (known === 0 && entry.status !== "completed" ? 1 : 0);
    const runtime = runtimeOf(key);
    for (let index = 0; index < extra; index++) {
      push(key, key, {
        at: null,
        seconds: runtime ?? 0,
        estimated: true,
        finish: true,
        rewatch: known + index > 0,
        source: "rewatch",
        missingRuntime: runtime === null,
      });
    }
  }

  return { entries, input };
}

export function inPeriod(at: number | null, period: Period): boolean {
  if (period.from === null && period.to === null) return true;
  if (at === null) return false;
  return (period.from === null || at >= period.from) && (period.to === null || at < period.to);
}

export interface KindTotals {
  seconds: number;
  titles: number;
  items: number;
}

export interface RatingStats {
  count: number;
  mean: number;
  histogram: number[];
  vsCommunity: number | null;
}

export interface Habits {
  sessions: number;
  parts: number[];
  weekdays: number[];
  audio: { dub: number; original: number; subtitles: number } | null;
  voices: { name: string; seconds: number }[];
  intro: number;
}

export interface TopTitle {
  key: string;
  name: string;
  kind: Kind;
  seconds: number;
}

export interface Overview {
  seconds: number;
  estimated: number;
  byKind: Record<Kind, KindTotals>;
  movies: number;
  episodes: number;
  series: number;
  missingRuntime: number;
  rating: RatingStats;
  plannedSeconds: number;
  plannedUnknown: number;
  days: Map<string, number>;
  activeDays: number;
  longestStreak: number;
  currentStreak: number;
  months: { month: string; totals: MonthTotals }[];
  genres: { id: number; seconds: number }[];
  decades: { decade: number; seconds: number }[];
  languages: { code: string; seconds: number }[];
  habits: Habits | null;
  recordDay: { key: string; name: string; episodes: number; day: string } | null;
  droppedAfter: number | null;
  top: TopTitle[];
  first: LedgerEntry | null;
  last: LedgerEntry | null;
  busiestMonth: string | null;
  rewatches: number;
}

function emptyTotals(): MonthTotals {
  return { movie: 0, tv: 0, anime: 0 };
}

function streaks(days: Set<string>, now: number): { longest: number; current: number } {
  const sorted = [...days].sort();
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const day of sorted) {
    const [y, m, d] = day.split("-").map(Number);
    const value = Math.round(new Date(y, m - 1, d).getTime() / dayMs);
    run = previous !== null && value - previous === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = value;
  }
  let current = 0;
  const cursor = new Date(now);
  if (!days.has(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dayKey(cursor.getTime()))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { longest, current };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function monthsBack(end: number, count: number): string[] {
  const date = new Date(end);
  const result: string[] = [];
  for (let index = count - 1; index >= 0; index--) {
    const point = new Date(date.getFullYear(), date.getMonth() - index, 1);
    result.push(monthKey(point.getTime()));
  }
  return result;
}

export function overview(ledger: Ledger, period: Period, kind: Kind | null, now: number): Overview {
  const { input } = ledger;
  const { tracked, info, hidden, archive, preferences, events } = input;
  const fits = (entry: LedgerEntry) => (kind === null || entry.kind === kind) && inPeriod(entry.at, period);
  const chosen = ledger.entries.filter(fits);
  const byKind: Record<Kind, KindTotals> = {
    movie: { seconds: 0, titles: 0, items: 0 },
    tv: { seconds: 0, titles: 0, items: 0 },
    anime: { seconds: 0, titles: 0, items: 0 },
  };
  const titlesByKind: Record<Kind, Set<string>> = { movie: new Set(), tv: new Set(), anime: new Set() };
  const missing = new Set<string>();
  let seconds = 0;
  let estimated = 0;
  let rewatches = 0;
  const movies = new Set<string>();
  const series = new Set<string>();
  let episodes = 0;
  const perTitle = new Map<string, TopTitle>();
  const genreSeconds = new Map<number, number>();
  const decadeSeconds = new Map<number, number>();
  const languageSeconds = new Map<string, number>();
  const monthTotals = new Map<string, MonthTotals>();
  const allDays = new Map<string, number>();

  for (const entry of ledger.entries) {
    if (entry.at === null || (kind !== null && entry.kind !== kind)) continue;
    const day = dayKey(entry.at);
    if (entry.seconds > 0 || entry.finish) allDays.set(day, (allDays.get(day) ?? 0) + entry.seconds);
    const month = monthKey(entry.at);
    const totals = monthTotals.get(month) ?? emptyTotals();
    totals[entry.kind] += entry.seconds;
    monthTotals.set(month, totals);
  }
  for (const [month, totals] of Object.entries(archive)) {
    const known = monthTotals.get(month) ?? emptyTotals();
    for (const item of kinds) if (kind === null || kind === item) known[item] += totals[item];
    monthTotals.set(month, known);
  }

  for (const entry of chosen) {
    seconds += entry.seconds;
    if (entry.estimated) estimated += entry.seconds;
    if (entry.missingRuntime) missing.add(entry.key);
    const kindTotals = byKind[entry.kind];
    kindTotals.seconds += entry.seconds;
    if (entry.finish) {
      titlesByKind[entry.kind].add(entry.key);
      if (entry.key.startsWith("movie:")) {
        movies.add(entry.key);
        kindTotals.items++;
        if (entry.rewatch) rewatches++;
      } else {
        episodes += entry.episodes;
        kindTotals.items += entry.episodes;
        series.add(entry.key);
      }
    }
    const top = perTitle.get(entry.key) ?? { key: entry.key, name: entry.name, kind: entry.kind, seconds: 0 };
    top.seconds += entry.seconds;
    perTitle.set(entry.key, top);
    const details = info.get(entry.key);
    if (details && entry.seconds > 0) {
      const genres = new Set(details.genres.flatMap((genre) => tvGenreTwins[genre] ?? [genre]));
      for (const genre of genres) genreSeconds.set(genre, (genreSeconds.get(genre) ?? 0) + entry.seconds);
      if (details.year > 1800) {
        const decade = Math.floor(details.year / 10) * 10;
        decadeSeconds.set(decade, (decadeSeconds.get(decade) ?? 0) + entry.seconds);
      }
      if (details.language) languageSeconds.set(details.language, (languageSeconds.get(details.language) ?? 0) + entry.seconds);
    }
  }
  for (const item of kinds) byKind[item].titles = titlesByKind[item].size;

  const wholeTime = period.from === null && period.to === null;
  for (const [month, totals] of Object.entries(archive)) {
    const [y, m] = month.split("-").map(Number);
    if (!wholeTime && !inPeriod(new Date(y, m - 1, 15).getTime(), period)) continue;
    for (const item of kinds) {
      if (kind !== null && kind !== item) continue;
      seconds += totals[item];
      byKind[item].seconds += totals[item];
    }
  }

  const ratingValues: { key: string; value: number }[] = [];
  if (wholeTime) {
    for (const [key, entry] of Object.entries(tracked)) {
      if (hidden[key] || typeof entry.rating !== "number" || entry.rating < 1) continue;
      if (kind !== null && kindOf(key, info) !== kind) continue;
      ratingValues.push({ key, value: entry.rating });
    }
  } else {
    const latest = new Map<string, number | null>();
    for (const event of events) {
      if (event.type !== "rating" || !inPeriod(event.at, period)) continue;
      const key = eventKey(event);
      if (!key || hidden[key] || (kind !== null && kindOf(key, info) !== kind)) continue;
      latest.set(key, typeof event.to === "number" ? event.to : null);
    }
    for (const [key, value] of latest) if (value !== null && value >= 1) ratingValues.push({ key, value });
  }
  const histogram = Array.from({ length: 10 }, () => 0);
  for (const { value } of ratingValues) histogram[Math.min(10, Math.max(1, Math.round(value))) - 1]++;
  const compared = ratingValues.filter(({ key }) => (info.get(key)?.vote ?? 0) > 0);
  const rating: RatingStats = {
    count: ratingValues.length,
    mean: ratingValues.length > 0 ? ratingValues.reduce((sum, item) => sum + item.value, 0) / ratingValues.length : 0,
    histogram,
    vsCommunity:
      compared.length >= leastRatings
        ? compared.reduce((sum, item) => sum + item.value - (info.get(item.key)?.vote ?? 0), 0) / compared.length
        : null,
  };

  let plannedSeconds = 0;
  let plannedUnknown = 0;
  for (const [key, entry] of Object.entries(tracked)) {
    if (hidden[key] || entry.status !== "planned") continue;
    if (kind !== null && kindOf(key, info) !== kind) continue;
    const minutes = entry.runtime ?? 0;
    const count = key.startsWith("movie:") ? 1 : (entry.totalEpisodes ?? 0);
    if (minutes > 0 && count > 0) plannedSeconds += minutes * 60 * count;
    else plannedUnknown++;
  }

  const periodDays = new Set<string>();
  for (const entry of chosen) if (entry.at !== null && (entry.seconds > 0 || entry.finish)) periodDays.add(dayKey(entry.at));
  const { longest, current } = streaks(new Set(allDays.keys()), now);

  const plays = chosen.filter((entry) => entry.source === "play" && entry.at !== null);
  let habits: Habits | null = null;
  if (plays.length >= leastHabitSessions) {
    const parts = [0, 0, 0, 0];
    const weekdays = [0, 0, 0, 0, 0, 0, 0];
    let dub = 0;
    let original = 0;
    let subtitles = 0;
    const voices = new Map<string, number>();
    let intro = 0;
    for (const play of plays) {
      const date = new Date(play.at as number);
      const hour = date.getHours();
      parts[hour < 6 ? 0 : hour < 12 ? 1 : hour < 18 ? 2 : 3] += play.seconds;
      weekdays[(date.getDay() + 6) % 7] += play.seconds;
      intro += play.intro;
      const language = info.get(play.key)?.language;
      if (play.audio && language) {
        if (play.audio === language) {
          original += play.seconds;
          if (play.subtitles) subtitles += play.seconds;
        } else dub += play.seconds;
      }
      const voice = preferences[play.key]?.releaseVoice;
      if (voice) voices.set(voice, (voices.get(voice) ?? 0) + play.seconds);
    }
    habits = {
      sessions: plays.length,
      parts,
      weekdays,
      audio: dub + original > 0 ? { dub, original, subtitles } : null,
      voices: [...voices.entries()].map(([name, value]) => ({ name, seconds: value })).sort((a, b) => b.seconds - a.seconds),
      intro,
    };
  }

  const perDay = new Map<string, { key: string; name: string; episodes: number; day: string }>();
  for (const entry of chosen) {
    if (entry.source !== "finish" || entry.at === null || entry.key.startsWith("movie:")) continue;
    const day = dayKey(entry.at);
    const id = `${day}|${entry.key}`;
    const known = perDay.get(id) ?? { key: entry.key, name: entry.name, episodes: 0, day };
    known.episodes += entry.episodes;
    perDay.set(id, known);
  }
  let recordDay: Overview["recordDay"] = null;
  for (const item of perDay.values()) if (item.episodes >= 3 && (!recordDay || item.episodes > recordDay.episodes)) recordDay = item;

  const droppedCounts: number[] = [];
  if (wholeTime) {
    for (const [key, entry] of Object.entries(tracked)) {
      if (hidden[key] || entry.status !== "dropped" || key.startsWith("movie:")) continue;
      if (kind !== null && kindOf(key, info) !== kind) continue;
      droppedCounts.push(ledger.entries.filter((item) => item.key === key && item.finish).reduce((sum, item) => sum + item.episodes, 0));
    }
  }

  const months = monthsBack(period.to !== null ? period.to - 1 : now, 12).map((month) => ({ month, totals: monthTotals.get(month) ?? emptyTotals() }));
  let busiestMonth: string | null = null;
  let busiest = 0;
  for (const [month, totals] of monthTotals) {
    const [y, m] = month.split("-").map(Number);
    if (!inPeriod(new Date(y, m - 1, 15).getTime(), period)) continue;
    const sum = totals.movie + totals.tv + totals.anime;
    if (sum > busiest) {
      busiest = sum;
      busiestMonth = month;
    }
  }

  const finishes = chosen.filter((entry) => entry.finish && entry.at !== null).sort((a, b) => (a.at as number) - (b.at as number));

  return {
    seconds,
    estimated,
    byKind,
    movies: movies.size,
    episodes,
    series: series.size,
    missingRuntime: missing.size,
    rating,
    plannedSeconds,
    plannedUnknown,
    days: allDays,
    activeDays: periodDays.size,
    longestStreak: longest,
    currentStreak: current,
    months,
    genres: [...genreSeconds.entries()].map(([id, value]) => ({ id, seconds: value })).sort((a, b) => b.seconds - a.seconds),
    decades: [...decadeSeconds.entries()].map(([decade, value]) => ({ decade, seconds: value })).sort((a, b) => a.decade - b.decade),
    languages: [...languageSeconds.entries()].map(([code, value]) => ({ code, seconds: value })).sort((a, b) => b.seconds - a.seconds),
    habits,
    recordDay,
    droppedAfter: droppedCounts.length >= leastDropped ? median(droppedCounts) : null,
    top: [...perTitle.values()].filter((item) => item.seconds > 0).sort((a, b) => b.seconds - a.seconds).slice(0, topLimit),
    first: finishes[0] ?? null,
    last: finishes[finishes.length - 1] ?? null,
    busiestMonth,
    rewatches,
  };
}

export interface HistoryEpisode {
  season: number;
  episode: number;
}

export interface HistoryItem {
  id: string;
  key: string;
  kind: Kind;
  name: string;
  year: string;
  at: number | null;
  seconds: number;
  estimated: boolean;
  approximate: boolean;
  finished: boolean;
  movie: boolean;
  episodes: HistoryEpisode[];
  estimatedEpisodes: number;
  rewatch: boolean;
  rating: number | null;
  eventIds: string[];
  markIds: string[];
}

export interface HistoryDay {
  day: string | null;
  seconds: number;
  approximate: boolean;
  items: HistoryItem[];
}

export interface HistoryFilter {
  kind: Kind | null;
  finishedOnly: boolean;
  key: string | null;
}

export function buildHistory(ledger: Ledger, filter: HistoryFilter): HistoryDay[] {
  const groups = new Map<string, HistoryItem>();
  const order: string[] = [];
  for (const entry of ledger.entries) {
    if (filter.kind !== null && entry.kind !== filter.kind) continue;
    if (filter.key !== null && entry.key !== filter.key) continue;
    const day = entry.at === null ? "" : dayKey(entry.at);
    const id = `${day}|${entry.key}`;
    let item = groups.get(id);
    if (!item) {
      item = {
        id,
        key: entry.key,
        kind: entry.kind,
        name: entry.name,
        year: entry.year,
        at: entry.at,
        seconds: 0,
        estimated: false,
        approximate: false,
        finished: false,
        movie: entry.key.startsWith("movie:"),
        episodes: [],
        estimatedEpisodes: 0,
        rewatch: false,
        rating: null,
        eventIds: [],
        markIds: [],
      };
      groups.set(id, item);
      order.push(id);
    }
    item.seconds += entry.seconds;
    item.estimated ||= entry.estimated;
    item.approximate ||= entry.approximate;
    if (entry.at !== null && (item.at === null || entry.at > item.at)) item.at = entry.at;
    if (entry.finish) {
      item.finished = true;
      if (entry.season !== undefined && entry.episode !== undefined) {
        if (!item.episodes.some((episode) => episode.season === entry.season && episode.episode === entry.episode)) {
          item.episodes.push({ season: entry.season, episode: entry.episode });
        }
      } else if (!item.movie) item.estimatedEpisodes += entry.episodes;
      if (entry.rewatch) item.rewatch = true;
    }
    item.eventIds.push(...entry.eventIds);
    if (entry.source === "mark") item.markIds.push(...entry.eventIds);
  }

  for (const event of ledger.input.events) {
    if (event.type !== "rating" || typeof event.to !== "number") continue;
    const key = eventKey(event);
    if (!key) continue;
    const item = groups.get(`${dayKey(event.at)}|${key}`);
    if (item) item.rating = event.to;
  }

  const days = new Map<string, HistoryDay>();
  for (const id of order) {
    const item = groups.get(id) as HistoryItem;
    if (filter.finishedOnly && !item.finished) continue;
    if (item.seconds <= 0 && !item.finished) continue;
    item.episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);
    const day = item.at === null ? "" : dayKey(item.at);
    const group = days.get(day) ?? { day: day || null, seconds: 0, approximate: false, items: [] };
    group.seconds += item.seconds;
    group.approximate ||= item.approximate;
    group.items.push(item);
    days.set(day, group);
  }
  const dated = [...days.values()].filter((group) => group.day !== null).sort((a, b) => (b.day as string).localeCompare(a.day as string));
  for (const group of dated) group.items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const earlier = days.get("");
  if (earlier) earlier.items.sort((a, b) => a.name.localeCompare(b.name));
  return earlier ? [...dated, earlier] : dated;
}

export function episodeRanges(episodes: HistoryEpisode[]): { season: number; ranges: [number, number][] }[] {
  const bySeason = new Map<number, number[]>();
  for (const { season, episode } of episodes) bySeason.set(season, [...(bySeason.get(season) ?? []), episode]);
  return [...bySeason.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, list]) => {
      const sorted = [...new Set(list)].sort((a, b) => a - b);
      const ranges: [number, number][] = [];
      for (const value of sorted) {
        const last = ranges[ranges.length - 1];
        if (last && value === last[1] + 1) last[1] = value;
        else ranges.push([value, value]);
      }
      return { season, ranges };
    });
}

export function titleTotals(ledger: Ledger, key: string): { seconds: number; episodes: number; rewatches: number; estimated: boolean } {
  let seconds = 0;
  let episodes = 0;
  let rewatches = 0;
  let estimated = false;
  for (const entry of ledger.entries) {
    if (entry.key !== key) continue;
    seconds += entry.seconds;
    estimated ||= entry.estimated && entry.seconds > 0;
    if (entry.finish) {
      episodes += entry.episodes;
      if (entry.rewatch) rewatches++;
    }
  }
  return { seconds, episodes, rewatches, estimated };
}

export function archiveBefore(ledger: Ledger, cutoff: number): Record<string, MonthTotals> {
  const result: Record<string, MonthTotals> = {};
  for (const entry of ledger.entries) {
    if (entry.at === null || entry.at >= cutoff || entry.eventIds.length === 0 || entry.source === "progress" || entry.source === "status") continue;
    const month = monthKey(entry.at);
    const totals = result[month] ?? emptyTotals();
    totals[entry.kind] += entry.seconds;
    result[month] = totals;
  }
  return result;
}

export function sinceDate(input: StatsInput, onboardedAt: number | undefined): number | null {
  const times: number[] = [];
  if (onboardedAt) times.push(onboardedAt);
  for (const entry of Object.values(input.tracked)) if (entry.addedAt) times.push(entry.addedAt);
  for (const item of Object.values(input.progress)) if (item.updatedAt) times.push(item.updatedAt);
  for (const event of input.events) times.push(event.at);
  return times.length > 0 ? Math.min(...times) : null;
}

export function letterboxdCsv(ledger: Ledger, ratings: Record<string, number | null>): string {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = ["tmdbID,Title,Year,WatchedDate,Rating10,Rewatch"];
  const finishes = ledger.entries
    .filter((entry) => entry.finish && entry.key.startsWith("movie:"))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  for (const entry of finishes) {
    const id = entry.key.split(":")[1];
    const rating = ratings[entry.key];
    rows.push(
      [id, quote(entry.name), entry.year, entry.at !== null ? dayKey(entry.at) : "", rating ? String(rating) : "", entry.rewatch ? "Yes" : "No"].join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}
