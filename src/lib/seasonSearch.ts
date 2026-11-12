import type { AnimePart } from "./anilist";
import type { SeasonInfo } from "./tmdb";

export interface SeasonProfile {
  number: number;
  label: string;
  names: string[];
  years: [number, number] | null;
}

export type MatchKind = "name" | "number" | "year" | "tv";

export interface SeasonMatch {
  seasons: number[];
  kind: MatchKind;
}

export interface SearchTask {
  query: string;
  page: number;
  quiet: boolean;
  season: number | null;
}

const shortestName = 4;
const animePartFormats: ReadonlySet<string> = new Set(["TV", "TV_SHORT", "ONA"]);
const partStartTolerance = 60 * 24 * 60 * 60 * 1000;
const namesPerSeasonQuery = 2;
const genericWords = new Set([
  "season",
  "seasons",
  "series",
  "part",
  "cour",
  "stage",
  "the",
  "final",
  "сезон",
  "сезона",
  "сезоны",
  "часть",
  "частина",
  "серия",
  "specials",
  "special",
  "спецвыпуски",
  "специальные",
  "выпуски",
  "спецвипуски",
]);
const trailingCount = /\s+(?:part|cour|season|сезон|часть|частина)?\s*\d+$/;
const romanTail = /\s+(?:ii|iii|iv|v|vi)$/;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function wordsOf(names: string[]): Set<string> {
  return new Set(names.flatMap((name) => normalize(name).split(" ")).filter(Boolean));
}

function isGeneric(text: string): boolean {
  return text.split(" ").every((word) => genericWords.has(word) || /^\d+(?:st|nd|rd|th|й|я)?$/.test(word));
}

const outsideSeasons = /\[(?:OVA|OAD|Movie|Фильм)\]|\((?:ОВА|OVA|OAD|фильм|movie)|(?:^|[\s.:/])(?:фильм|movie)(?=[\s.:/,]|$)/i;
const joinedNames = /\s*(?:&|\/|\+)\s*|\s+(?:and|и|і)\s+/i;
const wholeShow = /полный сериал|все сезоны|усі сезони|complete series|all seasons/i;

export function distinctiveNames(name: string, showWords: ReadonlySet<string>): string[] {
  const tail = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
  const variants = [name, tail, ...tail.split(joinedNames)];
  const found = new Set<string>();
  for (const variant of variants) {
    const words = normalize(variant).split(" ").filter(Boolean);
    while (words.length > 0 && showWords.has(words[0])) words.shift();
    let text = words.join(" ");
    for (let step = 0; step < 2; step++) text = text.replace(trailingCount, "").replace(romanTail, "").trim();
    if (text.length >= shortestName && !isGeneric(text)) found.add(text);
  }
  return [...found];
}

function dayOf(date: string): number | null {
  const time = Date.parse(date.length === 4 ? `${date}-01-01` : date.length === 7 ? `${date}-01` : date);
  return Number.isFinite(time) ? time : null;
}

function seasonOfPart(part: AnimePart, regular: SeasonInfo[]): number | null {
  const start = dayOf(part.startDate);
  if (start === null) return null;
  let found: number | null = null;
  for (const season of regular) {
    const airs = dayOf(season.airDate || season.year);
    if (airs !== null && airs <= start + partStartTolerance) found = season.seasonNumber;
  }
  return found;
}

export interface ProfileInput {
  seasons: SeasonInfo[];
  showNames: string[];
  seasonNames: Record<number, string[]>;
  animeParts: AnimePart[] | null;
  label: (season: SeasonInfo) => string;
  currentYear: number;
}

export function buildProfiles(input: ProfileInput): SeasonProfile[] {
  const regular = input.seasons.filter((season) => season.seasonNumber > 0).sort((a, b) => a.seasonNumber - b.seasonNumber);
  const animeNames = new Map<number, string[]>();
  for (const part of input.animeParts ?? []) {
    if (!animePartFormats.has(part.format)) continue;
    const season = seasonOfPart(part, regular);
    if (season === null) continue;
    animeNames.set(season, [...(animeNames.get(season) ?? []), part.romaji, part.english].filter(Boolean));
  }
  const showWords = wordsOf(input.showNames);
  const seasonWordCounts = new Map<string, number>();
  const candidates = regular.map((season) => {
    const raw = [season.name, ...(input.seasonNames[season.seasonNumber] ?? []), ...(animeNames.get(season.seasonNumber) ?? [])];
    return [...new Set(raw.flatMap((name) => distinctiveNames(name, showWords)))];
  });
  for (const names of candidates) for (const name of names) seasonWordCounts.set(name, (seasonWordCounts.get(name) ?? 0) + 1);
  return regular.map((season, index) => {
    const first = Number(season.year) || null;
    const next = regular.slice(index + 1).find((later) => Number(later.year) > 0);
    const nextYear = next ? Number(next.year) : null;
    const last = first === null ? null : nextYear === null ? Math.max(first, input.currentYear) : Math.max(first, nextYear - 1);
    return {
      number: season.seasonNumber,
      label: input.label(season),
      names: candidates[index].filter((name) => seasonWordCounts.get(name) === 1),
      years: first !== null && last !== null ? [first, last] : null,
    };
  });
}

export function releaseYears(title: string): [number, number] | null {
  for (const group of title.matchAll(/\[([^\]]*)\]/g)) {
    const range = /\b((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?\b/.exec(group[1]);
    if (range) {
      const first = Number(range[1]);
      const last = range[2] ? Number(range[2]) : first;
      return [Math.min(first, last), Math.max(first, last)];
    }
  }
  return null;
}

function numberedRange(title: string, patterns: RegExp[]): [number, number] | null {
  for (const pattern of patterns) {
    const found = pattern.exec(title);
    if (!found) continue;
    const first = Number(found[1]);
    const last = found[2] ? Number(found[2]) : first;
    if (first > 0 && last >= first && last - first < 60) return [first, last];
  }
  return null;
}

export function statedSeasons(title: string): [number, number] | null {
  return numberedRange(title, [
    /сезон[ыиа]?\s*:?\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?(?!\d)/i,
    /(?<!\d)(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*сезон/i,
    /\bs(\d{1,2})(?:\s*[-–]\s*s?(\d{1,2}))?(?:e\d|\b)/i,
    /\bseasons?\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\b/i,
  ]);
}

export function tvSeasons(title: string): [number, number] | null {
  return numberedRange(title, [/\((?:ТВ|TV)\s*-?\s*(\d{1,2})(?:\s*[-–,]\s*(\d{1,2}))?/i]);
}

function between(range: [number, number], known: ReadonlySet<number>): number[] {
  const numbers: number[] = [];
  for (let number = range[0]; number <= range[1]; number++) if (known.has(number)) numbers.push(number);
  return numbers;
}

export function matchSeasons(title: string, profiles: SeasonProfile[], anime: boolean): SeasonMatch | null {
  if (profiles.length === 0) return null;
  const years = releaseYears(title);
  const firstYear = Math.min(...profiles.map((profile) => profile.years?.[0] ?? Infinity));
  if (years && Number.isFinite(firstYear) && years[1] < firstYear - 1) return { seasons: [], kind: "year" };
  if (anime && outsideSeasons.test(title)) return { seasons: [], kind: "tv" };
  const text = ` ${normalize(title)} `;
  const named = profiles.filter((profile) => profile.names.some((name) => text.includes(` ${name} `))).map((profile) => profile.number);
  if (named.length > 0) return { seasons: named, kind: "name" };

  const known = new Set(profiles.map((profile) => profile.number));
  if (wholeShow.test(title)) return { seasons: [...known], kind: "number" };
  const stated = statedSeasons(title);
  const byNumber = stated ? between(stated, known) : [];
  const byYear = years
    ? profiles.filter((profile) => profile.years && profile.years[0] <= years[1] && years[0] <= profile.years[1]).map((profile) => profile.number)
    : [];
  const tv = tvSeasons(title);
  const byTv = tv ? between(tv, known) : [];

  if (!anime && byNumber.length > 0) return { seasons: byNumber, kind: "number" };
  if (byYear.length > 0 && byYear.length < profiles.length) return { seasons: byYear, kind: "year" };
  if (byNumber.length > 0) return { seasons: byNumber, kind: "number" };
  if (byTv.length > 0) return { seasons: byTv, kind: "tv" };
  if (byYear.length > 0) return { seasons: byYear, kind: "year" };
  return null;
}

function sameScript(a: string, b: string): boolean {
  const cyrillic = (text: string) => /\p{Script=Cyrillic}/u.test(text);
  return cyrillic(a) === cyrillic(b);
}

export function seasonQueries(showNames: string[], profile: SeasonProfile): SearchTask[] {
  const tasks: SearchTask[] = [];
  const shortestFirst = [...profile.names].sort((a, b) => a.split(" ").length - b.split(" ").length || a.length - b.length);
  for (const name of shortestFirst) {
    const show = showNames.find((candidate) => candidate && sameScript(candidate, name));
    if (!show) continue;
    tasks.push({ query: `${show} ${name}`, page: 0, quiet: true, season: profile.number });
    if (tasks.length === namesPerSeasonQuery) break;
  }
  return tasks;
}

export function taskKey(task: Pick<SearchTask, "query" | "page">): string {
  return `${normalize(task.query)}#${task.page}`;
}
