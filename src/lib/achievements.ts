import type { Ledger, LedgerEntry } from "./profileStats";

export type AchievementGroup = "watch" | "habits" | "taste" | "social" | "special" | "secret";

export type AchievementIcon =
  | "clock"
  | "film"
  | "tv"
  | "list"
  | "sparkles"
  | "flame"
  | "star"
  | "palette"
  | "globe"
  | "languages"
  | "users"
  | "popcorn"
  | "zap"
  | "calendar"
  | "ticket"
  | "moon"
  | "coffee"
  | "hourglass"
  | "landmark"
  | "timer"
  | "mountain"
  | "trophy"
  | "party"
  | "repeat"
  | "gift"
  | "ghost"
  | "music"
  | "forward";

export interface AchievementDef {
  id: string;
  group: AchievementGroup;
  icon: AchievementIcon;
  tiers: number[];
  unit: "hours" | "count" | "days";
  secret?: boolean;
  live?: boolean;
}

export const achievementDefs: AchievementDef[] = [
  { id: "screenTime", group: "watch", icon: "clock", tiers: [10, 250, 2000, 10000], unit: "hours" },
  { id: "movies", group: "watch", icon: "film", tiers: [10, 100, 400, 1000], unit: "count" },
  { id: "series", group: "watch", icon: "tv", tiers: [3, 15, 50, 100], unit: "count" },
  { id: "episodes", group: "watch", icon: "list", tiers: [100, 1000, 4000, 10000], unit: "count" },
  { id: "anime", group: "watch", icon: "sparkles", tiers: [10, 100, 300, 1000], unit: "hours" },
  { id: "streak", group: "habits", icon: "flame", tiers: [7, 30, 100, 365], unit: "days", live: true },
  { id: "ratings", group: "taste", icon: "star", tiers: [10, 50, 200, 500], unit: "count" },
  { id: "genres", group: "taste", icon: "palette", tiers: [5, 10, 15, 19], unit: "count" },
  { id: "languages", group: "taste", icon: "globe", tiers: [3, 7, 15, 25], unit: "count" },
  { id: "original", group: "taste", icon: "languages", tiers: [10, 50, 200, 500], unit: "hours", live: true },
  { id: "friends", group: "social", icon: "users", tiers: [1, 3, 5, 10], unit: "count" },
  { id: "together", group: "social", icon: "popcorn", tiers: [1, 5, 20, 50], unit: "count" },
  { id: "marathon", group: "special", icon: "zap", tiers: [1], unit: "count", live: true },
  { id: "weekend", group: "special", icon: "calendar", tiers: [1], unit: "count", live: true },
  { id: "double", group: "special", icon: "ticket", tiers: [1], unit: "count", live: true },
  { id: "night", group: "special", icon: "moon", tiers: [10], unit: "count", live: true },
  { id: "morning", group: "special", icon: "coffee", tiers: [10], unit: "count", live: true },
  { id: "decades", group: "special", icon: "hourglass", tiers: [6], unit: "count" },
  { id: "classic", group: "special", icon: "landmark", tiers: [1], unit: "count" },
  { id: "patience", group: "special", icon: "timer", tiers: [1], unit: "count" },
  { id: "adventure", group: "special", icon: "mountain", tiers: [200], unit: "count" },
  { id: "perfect", group: "special", icon: "trophy", tiers: [1], unit: "count" },
  { id: "fullHouse", group: "special", icon: "party", tiers: [1], unit: "count" },
  { id: "rewatch", group: "secret", icon: "repeat", tiers: [1], unit: "count", secret: true },
  { id: "newYear", group: "secret", icon: "gift", tiers: [1], unit: "count", secret: true, live: true },
  { id: "halloween", group: "secret", icon: "ghost", tiers: [1], unit: "count", secret: true, live: true },
  { id: "intro", group: "secret", icon: "music", tiers: [20], unit: "count", secret: true, live: true },
  { id: "skipper", group: "secret", icon: "forward", tiers: [100], unit: "count", secret: true, live: true },
];

export const tierNames = ["bronze", "silver", "gold", "platinum"] as const;
export type TierName = (typeof tierNames)[number];

export interface AchievementState {
  def: AchievementDef;
  value: number;
  tier: number;
  unlocked: (number | null)[];
}

export interface AchievementExtras {
  friends: number;
  now: number;
}

const hourSeconds = 3600;
const genreSeconds = 3600;
const longMovieSeconds = 180 * 60;
const marathonEpisodes = 6;
const weekendEpisodes = 8;
const fullHouseSize = 4;
const horrorGenre = 27;
const classicYear = 1970;
const dayMs = 86_400_000;
const eveningShiftHours = 5;
const eveningFromHour = 12;

class Track {
  value = 0;
  readonly unlocked: (number | null)[] = [];
  readonly def: AchievementDef;

  constructor(def: AchievementDef) {
    this.def = def;
  }

  set(value: number, at: number | null): void {
    if (value <= this.value) return;
    this.value = value;
    while (this.unlocked.length < this.def.tiers.length && this.value >= this.def.tiers[this.unlocked.length]) this.unlocked.push(at);
  }

  add(amount: number, at: number | null): void {
    this.set(this.value + amount, at);
  }

  state(): AchievementState {
    return { def: this.def, value: this.value, tier: this.unlocked.length, unlocked: [...this.unlocked] };
  }
}

function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function dayNumber(at: number): number {
  const date = new Date(at);
  return Math.round(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / dayMs);
}

function weekendOf(at: number): string | null {
  const date = new Date(at);
  const weekday = date.getDay();
  if (weekday !== 6 && weekday !== 0) return null;
  const saturday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - (weekday === 0 ? 1 : 0));
  return localDay(saturday.getTime());
}

function eveningOf(at: number): string | null {
  const shifted = new Date(at - eveningShiftHours * hourSeconds * 1000);
  return shifted.getHours() >= eveningFromHour ? localDay(shifted.getTime()) : null;
}

function isLive(entry: LedgerEntry): boolean {
  return entry.at !== null && (entry.source === "play" || entry.source === "finish");
}

function bump(map: Map<string, number>, key: string, amount = 1): number {
  const next = (map.get(key) ?? 0) + amount;
  map.set(key, next);
  return next;
}

export function computeAchievements(ledger: Ledger, extras: AchievementExtras): AchievementState[] {
  const tracks = new Map(achievementDefs.map((def) => [def.id, new Track(def)]));
  const track = (id: string) => tracks.get(id) as Track;
  const { tracked, info, progress, events } = ledger.input;

  const entries = [...ledger.entries].sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity));
  const finishedMovies = new Set<string>();
  const episodesByKey = new Map<string, number>();
  const genreTime = new Map<number, number>();
  const genresReached = new Set<number>();
  const languages = new Set<string>();
  const decades = new Set<number>();
  const perDay = new Map<string, number>();
  const perWeekend = new Map<string, number>();
  const evenings = new Map<string, Set<string>>();
  const nights = new Set<string>();
  const mornings = new Set<string>();
  let streakDay: number | null = null;
  let streak = 0;
  let introRun = 0;

  for (const entry of entries) {
    const at = entry.at;
    const movie = entry.key.startsWith("movie:");
    const facts = info.get(entry.key);
    const live = isLive(entry);

    track("screenTime").add(entry.seconds / hourSeconds, at);
    if (entry.kind === "anime") track("anime").add(entry.seconds / hourSeconds, at);

    if (facts) {
      for (const genre of facts.genres) {
        const time = (genreTime.get(genre) ?? 0) + entry.seconds;
        genreTime.set(genre, time);
        if (time >= genreSeconds && !genresReached.has(genre)) {
          genresReached.add(genre);
          track("genres").set(genresReached.size, at);
        }
      }
    }

    if (entry.episodes > 0) {
      track("episodes").add(entry.episodes, at);
      const total = bump(episodesByKey, entry.key, entry.episodes);
      track("adventure").set(total, at);
    }

    if (entry.finish) {
      if (facts?.language && !languages.has(facts.language)) {
        languages.add(facts.language);
        track("languages").set(languages.size, at);
      }
      if (movie) {
        if (entry.rewatch || finishedMovies.has(entry.key)) track("rewatch").set(1, at);
        if (!finishedMovies.has(entry.key)) {
          finishedMovies.add(entry.key);
          track("movies").set(finishedMovies.size, at);
        }
        const year = facts?.year || Number(entry.year) || 0;
        if (year > 1800) {
          decades.add(Math.floor(year / 10) * 10);
          track("decades").set(decades.size, at);
          if (year < classicYear) track("classic").set(1, at);
        }
        const length = progress[entry.unit]?.duration || (tracked[entry.key]?.runtime ?? 0) * 60;
        if (length > longMovieSeconds) track("patience").set(1, at);
      }
    }

    if (!live || at === null) continue;
    const date = new Date(at);
    const hour = date.getHours();

    if (facts && entry.source === "play" && entry.audio && entry.audio === facts.language) track("original").add(entry.seconds / hourSeconds, at);

    const day = dayNumber(at);
    if (streakDay === null || day > streakDay) {
      streak = streakDay !== null && day === streakDay + 1 ? streak + 1 : 1;
      streakDay = day;
      track("streak").set(streak, at);
    }

    if (entry.source === "play") {
      const session = `${entry.unit}|${localDay(at)}`;
      if (hour < 4) {
        nights.add(session);
        track("night").set(nights.size, at);
      }
      if (hour >= 5 && hour < 8) {
        mornings.add(session);
        track("morning").set(mornings.size, at);
      }
      if (entry.intro > 0) {
        introRun = 0;
        track("skipper").add(1, at);
      }
    }

    const month = date.getMonth();
    const dayOfMonth = date.getDate();
    if ((month === 11 && dayOfMonth === 31 && hour >= 22) || (month === 0 && dayOfMonth === 1 && hour < 3)) track("newYear").set(1, at);
    if (month === 9 && dayOfMonth === 31 && facts?.genres.includes(horrorGenre)) track("halloween").set(1, at);

    if (entry.source !== "finish") continue;
    if (entry.episodes > 0) {
      introRun += 1;
      track("intro").set(introRun, at);
      track("marathon").set(bump(perDay, `${entry.key}|${localDay(at)}`, entry.episodes) >= marathonEpisodes ? 1 : 0, at);
      const weekend = weekendOf(at);
      if (weekend) track("weekend").set(bump(perWeekend, `${entry.key}|${weekend}`, entry.episodes) >= weekendEpisodes ? 1 : 0, at);
    }
    if (movie) {
      const evening = eveningOf(at);
      if (evening) {
        const seen = evenings.get(evening) ?? new Set<string>();
        seen.add(entry.key);
        evenings.set(evening, seen);
        if (seen.size >= 2) track("double").set(1, at);
      }
    }
  }

  const completed = Object.entries(tracked)
    .filter(([key, entry]) => key.startsWith("tv:") && entry.status === "completed")
    .map(([, entry]) => entry.finishedAt ?? entry.fieldsUpdatedAt?.status ?? entry.updatedAt ?? null)
    .sort((a, b) => (a ?? -Infinity) - (b ?? -Infinity));
  completed.forEach((at, index) => track("series").set(index + 1, at));

  const ratings = Object.values(tracked)
    .filter((entry) => typeof entry.rating === "number" && entry.rating > 0)
    .map((entry) => ({ at: entry.fieldsUpdatedAt?.rating ?? entry.updatedAt ?? null, rating: entry.rating as number }))
    .sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity));
  ratings.forEach((item, index) => {
    track("ratings").set(index + 1, item.at);
    if (item.rating >= 10) track("perfect").set(1, item.at);
  });

  const parties = events
    .filter((event) => event.type === "party" && typeof event.at === "number")
    .sort((a, b) => a.at - b.at);
  parties.forEach((event, index) => {
    track("together").set(index + 1, event.at);
    if (typeof event.size === "number" && event.size >= fullHouseSize) track("fullHouse").set(1, event.at);
  });

  track("friends").set(extras.friends, extras.now);

  return achievementDefs.map((def) => track(def.id).state());
}

export function earnedCount(states: AchievementState[]): number {
  return states.reduce((sum, state) => sum + state.tier, 0);
}

export function showcase(states: AchievementState[], limit: number): AchievementState[] {
  const order = new Map(achievementDefs.map((def, index) => [def.id, index]));
  const weight = (state: AchievementState) => (state.def.tiers.length === 1 ? (state.def.secret ? 2.6 : 2.2) : state.tier);
  return states
    .filter((state) => state.tier > 0)
    .sort((a, b) => weight(b) - weight(a) || (order.get(a.def.id) ?? 0) - (order.get(b.def.id) ?? 0))
    .slice(0, limit);
}

export function nextGoal(state: AchievementState): number | null {
  return state.tier < state.def.tiers.length ? state.def.tiers[state.tier] : null;
}
