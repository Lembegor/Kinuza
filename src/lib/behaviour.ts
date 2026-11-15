import type { ActivityEvent } from "../state/activity";

const msPerDay = 86_400_000;
const rewatchGapMs = 6 * 60 * 60 * 1000;
const interestWindowDays = 45;
const searchWindowDays = 3;
const searchToOpenMs = 120_000;
const leastSkippingSeconds = 15 * 60;
const leastPlaySeconds = 5 * 60;
const paceWindowDays = 90;

export interface Interest {
  score: number;
  at: number;
  name: string;
  year: string;
}

export interface SlotStats {
  count: number;
  mean: number;
  spread: number;
  tvShare: number;
}

export interface Behaviour {
  rewatched: Map<string, number>;
  pace: Map<string, number>;
  skipping: Map<string, number>;
  interest: Map<string, Interest>;
  started: Map<string, number>;
  opened: Map<string, number>;
  feedOpened: Map<string, number>;
  language: { seconds: number; subtitles: number; audio: Map<string, number> };
  slots: SlotStats[];
  overall: SlotStats;
  searches: { query: string; at: number }[];
}

interface EventTitle {
  type?: string;
  id?: number;
  name?: string;
  year?: string;
}

function titleKeyOf(event: ActivityEvent): string | null {
  const title = event.title as EventTitle | undefined;
  if (!title || (title.type !== "movie" && title.type !== "tv") || typeof title.id !== "number") return null;
  return `${title.type}:${title.id}`;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function slotOf(at: number): number {
  const date = new Date(at);
  const day = date.getDay();
  const weekend = day === 0 || day === 6 ? 1 : 0;
  const hour = date.getHours();
  const part = hour < 6 ? 0 : hour < 12 ? 1 : hour < 18 ? 2 : 3;
  return weekend * 4 + part;
}

function stats(values: { minutes: number; tv: boolean }[]): SlotStats {
  if (values.length === 0) return { count: 0, mean: 0, spread: 0, tvShare: 0 };
  const logs = values.map((value) => Math.log(Math.max(1, value.minutes)));
  const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
  const spread = Math.sqrt(logs.reduce((sum, value) => sum + (value - mean) ** 2, 0) / logs.length);
  return { count: values.length, mean, spread, tvShare: values.filter((value) => value.tv).length / values.length };
}

function paceBonus(perDay: number): number {
  if (perDay < 1) return 0;
  return Math.min(0.5, 0.12 + 0.17 * (perDay - 1));
}

function skippingPenalty(share: number): number {
  if (share < 0.15) return 0;
  return -0.2 * Math.min(1, (share - 0.1) / 0.3);
}

export function readBehaviour(events: ActivityEvent[], now: number): Behaviour {
  const ordered = [...events].sort((a, b) => a.at - b.at);
  const completions = new Map<string, number[]>();
  const seriesDays = new Map<string, Map<number, number>>();
  const plays = new Map<string, { played: number; skipped: number; fast: number }>();
  const started = new Map<string, number>();
  const opened = new Map<string, number>();
  const feedOpened = new Map<string, number>();
  const slotValues: { minutes: number; tv: boolean }[][] = Array.from({ length: 8 }, () => []);
  const allValues: { minutes: number; tv: boolean }[] = [];
  const language = { seconds: 0, subtitles: 0, audio: new Map<string, number>() };
  const searches: { query: string; at: number }[] = [];

  interface Evidence {
    openDays: Set<number>;
    view: number;
    trailer: number;
    glanced: boolean;
    fromSearch: boolean;
    picked: boolean;
    at: number;
    name: string;
    year: string;
  }
  const evidence = new Map<string, Evidence>();
  const evidenceOf = (key: string, event: ActivityEvent): Evidence => {
    const title = event.title as EventTitle;
    const known = evidence.get(key) ?? {
      openDays: new Set<number>(),
      view: 0,
      trailer: 0,
      glanced: false,
      fromSearch: false,
      picked: false,
      at: 0,
      name: title.name ?? "",
      year: title.year ?? "",
    };
    known.at = Math.max(known.at, event.at);
    evidence.set(key, known);
    return known;
  };
  const interestSince = now - interestWindowDays * msPerDay;
  let lastSearchAt = 0;

  for (const event of ordered) {
    const key = titleKeyOf(event);
    switch (event.type) {
      case "search": {
        lastSearchAt = event.at;
        const query = typeof event.query === "string" ? event.query.trim() : "";
        if (query && now - event.at < searchWindowDays * msPerDay) searches.push({ query, at: event.at });
        break;
      }
      case "watched": {
        if (!key || event.marked === true || typeof event.unit !== "string") break;
        const list = completions.get(event.unit) ?? [];
        list.push(event.at);
        completions.set(event.unit, list);
        if (key.startsWith("tv:") && now - event.at < paceWindowDays * msPerDay) {
          const days = seriesDays.get(key) ?? new Map<number, number>();
          const day = Math.floor(event.at / msPerDay);
          days.set(day, (days.get(day) ?? 0) + 1);
          seriesDays.set(key, days);
        }
        break;
      }
      case "play": {
        if (!key) break;
        const seconds = number(event.seconds);
        const entry = plays.get(key) ?? { played: 0, skipped: 0, fast: 0 };
        entry.played += seconds;
        entry.skipped += number(event.skipped);
        entry.fast += number(event.fast);
        plays.set(key, entry);
        if (!started.has(key)) started.set(key, event.at);
        if (seconds >= leastPlaySeconds) {
          language.seconds += seconds;
          if (event.subtitles === true) language.subtitles += seconds;
          if (typeof event.audio === "string" && event.audio) language.audio.set(event.audio, (language.audio.get(event.audio) ?? 0) + seconds);
          const duration = number(event.duration);
          if (duration > 0) {
            const value = { minutes: duration / 60, tv: key.startsWith("tv:") };
            slotValues[slotOf(event.at)].push(value);
            allValues.push(value);
          }
        }
        break;
      }
      case "title.open": {
        if (!key) break;
        opened.set(key, event.at);
        if (event.at < interestSince) break;
        const known = evidenceOf(key, event);
        known.openDays.add(Math.floor(event.at / msPerDay));
        if (event.at - lastSearchAt < searchToOpenMs) known.fromSearch = true;
        break;
      }
      case "title.view": {
        if (!key || event.at < interestSince) break;
        const known = evidenceOf(key, event);
        known.view = Math.max(known.view, number(event.seconds));
        break;
      }
      case "trailer": {
        if (!key || event.at < interestSince) break;
        const known = evidenceOf(key, event);
        const length = number(event.length);
        const watched = number(event.watched);
        const seconds = number(event.seconds);
        const share = length > 0 ? watched / length : Math.min(1, seconds / 75);
        let value = 0;
        if (event.external === true) value = 0.06;
        else if (share >= 0.6 || watched >= 60) value = 0.06;
        else if (share >= 0.3) value = 0.03;
        else if (seconds < 12) known.glanced = true;
        known.trailer = Math.max(known.trailer, value);
        break;
      }
      case "tracker.pick": {
        if (!key || event.at < interestSince) break;
        evidenceOf(key, event).picked = true;
        break;
      }
      case "feed.open": {
        if (key) feedOpened.set(key, event.at);
        break;
      }
      default:
        break;
    }
  }

  const rewatched = new Map<string, number>();
  const repeatedEpisodes = new Map<string, number>();
  for (const [unit, times] of completions) {
    let repeats = 0;
    let last = times[0];
    for (const at of times.slice(1)) {
      if (at - last > rewatchGapMs) repeats += 1;
      last = at;
    }
    if (repeats === 0) continue;
    const parts = unit.split(":");
    const key = `${parts[0]}:${parts[1]}`;
    if (parts[0] === "movie") rewatched.set(key, repeats);
    else repeatedEpisodes.set(key, (repeatedEpisodes.get(key) ?? 0) + 1);
  }
  for (const [key, episodes] of repeatedEpisodes) if (episodes >= 2) rewatched.set(key, 1);

  const pace = new Map<string, number>();
  for (const [key, days] of seriesDays) {
    const counts = [...days.values()];
    const episodes = counts.reduce((sum, value) => sum + value, 0);
    if (episodes < 3) continue;
    const bonus = paceBonus(episodes / counts.length);
    if (bonus > 0) pace.set(key, bonus);
  }

  const skipping = new Map<string, number>();
  for (const [key, entry] of plays) {
    if (entry.played < leastSkippingSeconds) continue;
    const share = (entry.skipped + entry.fast * 0.5) / (entry.played + entry.skipped);
    const penalty = skippingPenalty(share);
    if (penalty < 0) skipping.set(key, penalty);
  }

  const interest = new Map<string, Interest>();
  for (const [key, found] of evidence) {
    const bounced = found.openDays.size <= 1 && found.view < 6 && found.trailer === 0 && !found.picked;
    if (bounced) continue;
    let score = Math.min(0.03 * found.openDays.size, 0.09);
    score += found.view >= 120 ? 0.05 : found.view >= 30 ? 0.03 : 0;
    score += found.trailer;
    if (found.glanced && found.trailer === 0) score -= 0.02;
    if (found.fromSearch) score += 0.04;
    if (found.picked) score += 0.08;
    score = Math.max(0, Math.min(0.25, score));
    if (score > 0) interest.set(key, { score, at: found.at, name: found.name, year: found.year });
  }

  return {
    rewatched,
    pace,
    skipping,
    interest,
    started,
    opened,
    feedOpened,
    language,
    slots: slotValues.map(stats),
    overall: stats(allValues),
    searches: searches.slice(-8),
  };
}

export function contextFit(behaviour: Behaviour, minutes: number, tv: boolean, at: number): number {
  const slot = behaviour.slots[slotOf(at)];
  const overall = behaviour.overall;
  if (minutes <= 0 || slot.count < 8 || overall.count < 20) return 0;
  const value = Math.log(minutes);
  const here = Math.exp(-(((value - slot.mean) / Math.max(0.25, slot.spread)) ** 2) / 2);
  const usual = Math.exp(-(((value - overall.mean) / Math.max(0.25, overall.spread)) ** 2) / 2);
  const kind = (tv ? slot.tvShare - overall.tvShare : overall.tvShare - slot.tvShare) * 0.5;
  return Math.max(-1, Math.min(1, here - usual + kind));
}

export function interestWeight(interest: Interest, now: number): number {
  return interest.score * 0.5 ** ((now - interest.at) / (10 * msPerDay));
}
