import { releaseYears } from "./seasonSearch";
import { tmdb, type Episode, type SeasonInfo } from "./tmdb";

export interface Arc {
  season: number;
  name: string;
  first: number;
  last: number;
  chunk: boolean;
}

export interface EpisodeLayout {
  arcs: Arc[];
  first: number;
  last: number;
  seasons: number[];
}

export interface Coverage {
  first: number;
  last: number;
}

export type ReleaseKind = "series" | "recut" | "extra" | "other" | "unknown";

export interface ReleaseCoverage {
  kind: ReleaseKind;
  range: Coverage | null;
}

export const longSeriesMinEpisodes = 100;
const chunkSize = 100;
const chunkAbove = 150;
const ongoingSlack = 60;

const layoutMemory = new Map<string, Promise<EpisodeLayout | null>>();

function regularSeasons(seasons: SeasonInfo[]): SeasonInfo[] {
  return seasons.filter((season) => season.seasonNumber > 0 && season.episodeCount > 0).sort((a, b) => a.seasonNumber - b.seasonNumber);
}

function firstNumber(episodes: Episode[]): number | null {
  const numbers = episodes.map((episode) => episode.episode).filter((value) => Number.isFinite(value));
  return numbers.length > 0 ? Math.min(...numbers) : null;
}

function lastNumber(episodes: Episode[]): number | null {
  const numbers = episodes.map((episode) => episode.episode).filter((value) => Number.isFinite(value));
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function chunked(season: SeasonInfo, first: number, last: number): Arc[] {
  if (last - first + 1 <= chunkAbove) return [{ season: season.seasonNumber, name: season.name, first, last, chunk: false }];
  const arcs: Arc[] = [];
  for (let start = first; start <= last; start += chunkSize) {
    arcs.push({ season: season.seasonNumber, name: "", first: start, last: Math.min(start + chunkSize - 1, last), chunk: true });
  }
  return arcs;
}

export function buildLayout(seasons: SeasonInfo[], firsts: Map<number, number>, lasts: Map<number, number>): EpisodeLayout | null {
  const regular = regularSeasons(seasons);
  if (regular.length === 0) return null;
  const run: { season: SeasonInfo; first: number; last: number }[] = [];
  let expected = 1;
  for (const season of regular) {
    const first = firsts.get(season.seasonNumber) ?? expected;
    if (first !== expected) break;
    const last = lasts.get(season.seasonNumber) ?? first + season.episodeCount - 1;
    run.push({ season, first, last });
    expected = last + 1;
  }
  if (run.length === 0) return null;
  const last = run[run.length - 1].last;
  if (last < longSeriesMinEpisodes) return null;
  if (run.length === 1 && regular.length > 1 && run[0].last - run[0].first + 1 < longSeriesMinEpisodes) return null;
  return {
    arcs: run.flatMap((entry) =>
      run.length === 1 ? chunked(entry.season, entry.first, entry.last) : [{ season: entry.season.seasonNumber, name: entry.season.name, first: entry.first, last: entry.last, chunk: false }],
    ),
    first: 1,
    last,
    seasons: run.map((entry) => entry.season.seasonNumber),
  };
}

async function loadLayout(seriesId: number, seasons: SeasonInfo[]): Promise<EpisodeLayout | null> {
  const regular = regularSeasons(seasons);
  const total = regular.reduce((sum, season) => sum + season.episodeCount, 0);
  if (total < longSeriesMinEpisodes) return null;
  if (regular.length === 1) return buildLayout(seasons, new Map([[regular[0].seasonNumber, 1]]), new Map());
  const firsts = new Map<number, number>();
  const lasts = new Map<number, number>();
  const read = async (season: SeasonInfo) => {
    const episodes = await tmdb.season(seriesId, season.seasonNumber);
    const first = firstNumber(episodes);
    const last = lastNumber(episodes);
    if (first !== null) firsts.set(season.seasonNumber, first);
    if (last !== null) lasts.set(season.seasonNumber, last);
  };
  await Promise.all([read(regular[0]), read(regular[1])]);
  const continuing = firsts.get(regular[1].seasonNumber) === (lasts.get(regular[0].seasonNumber) ?? 0) + 1;
  if (!continuing) return buildLayout(seasons, firsts, lasts);
  await Promise.all(regular.slice(2).map((season) => read(season).catch(() => undefined)));
  return buildLayout(seasons, firsts, lasts);
}

export function episodeLayout(seriesId: number, seasons: SeasonInfo[], isAnime: boolean): Promise<EpisodeLayout | null> {
  if (!isAnime) return Promise.resolve(null);
  const key = `${seriesId}:${regularSeasons(seasons).map((season) => `${season.seasonNumber}/${season.episodeCount}`).join(",")}`;
  const known = layoutMemory.get(key);
  if (known) return known;
  const pending = loadLayout(seriesId, seasons).catch(() => null);
  layoutMemory.set(key, pending);
  return pending;
}

export function arcOf(layout: EpisodeLayout, episode: number): Arc | null {
  return layout.arcs.find((arc) => episode >= arc.first && episode <= arc.last) ?? null;
}

export function arcsOfSeason(layout: EpisodeLayout, season: number): Arc[] {
  return layout.arcs.filter((arc) => arc.season === season);
}

export function inLayout(layout: EpisodeLayout, season: number): boolean {
  return layout.seasons.includes(season);
}

const rangePatterns = [
  /(?:сери[иийя]|эпизод[ыа]?|episodes?|eps?\.?|ep)\s*:?\s*(\d{1,4})\s*[-–—]\s*(\d{1,4})(?!\d)/i,
  /[[(]\s*(?:tv|тв)?\s*:?\s*(\d{1,4})\s*[-–—]\s*(\d{1,4})(?:\s*\+\s*\d{1,3})?\s*(?:из|of|\/)\s*(?:\d{1,4}\+?|[xх?]+|>\s*\d{1,4}|\.\.\.)/i,
  /[[(]\s*(\d{1,4})\s*[-–—]\s*(\d{1,4})\s*[\])]/,
  /(?<![\d.])(\d{1,4})\s*[-–—]\s*(\d{1,4})(?:\s*\+\s*\d{1,3})?\s*(?:из|of)\s*(?:\d{1,4}\+?|[xх?]+|>\s*\d{1,4})/i,
];
const singlePatterns = [
  /(?:сери[яи]|эпизод|episode|ep)\s*:?\s*(\d{1,4})\s*(?:из|of)\s*(?:\d{1,4}\+?|[xх?]+|>\s*\d{1,4})/i,
  /[[(]\s*(\d{1,4})\s*(?:из|of)\s*(?:\d{1,4}\+?|[xх?]+|>\s*\d{1,4})\s*[\])]/i,
];
const statedSeasonPattern = /(?:сезон[ы]?|season)\s*:?\s*(\d{1,2})(?!\d)|(?<!\d)(\d{1,2})\s*(?:-?й)?\s*сезон/i;
const statedTotalPattern = /(?:из|of)\s*(\d{1,4})(?!\d)/i;
const extraPattern = /\b(?:фильм[ыа]?|movies?|спешл[ыа]?|specials?|спецвыпуск[иа]?|ova|ona|oad|recap|рекап)\b/i;
const recutPattern = /без\s*филл?ер|no[\s._-]?fill?ers?|filler[\s._-]?free|re-?cut|перемонтаж|fan[\s._-]?edit|фан[\s-]?(?:монтаж|эдит)/i;

export function isRecut(text: string): boolean {
  return recutPattern.test(text);
}

const tvPattern = /\[\s*(?:tv|тв)\b|\btv\s*(?:series|сериал)|\(\s*tv\s*\)|\bтв-сериал/i;

function numericRange(title: string): Coverage | null {
  for (const pattern of rangePatterns) {
    const found = pattern.exec(title);
    if (!found) continue;
    const first = Number(found[1]);
    const last = Number(found[2]);
    if (first >= 1 && last >= first) return { first, last };
  }
  for (const pattern of singlePatterns) {
    const found = pattern.exec(title);
    if (found) return { first: Number(found[1]), last: Number(found[1]) };
  }
  return null;
}

function statedSeason(title: string): number | null {
  const found = statedSeasonPattern.exec(title);
  return found ? Number(found[1] ?? found[2]) : null;
}

function statedTotal(title: string, after: number): number | null {
  const found = statedTotalPattern.exec(title.slice(after));
  return found ? Number(found[1]) : null;
}

function releaseStartYear(title: string): number | null {
  return releaseYears(title)?.[0] ?? null;
}

export function releaseCoverage(title: string, layout: EpisodeLayout, showYear: number | null = null): ReleaseCoverage {
  const range = numericRange(title);
  const unknown: ReleaseCoverage = { kind: "unknown", range: null };
  const extraOnly = extraPattern.test(title) && !tvPattern.test(title) && !/сери|episod|эпизод/i.test(title);
  if (extraOnly || (!range && extraPattern.test(title))) return { kind: "extra", range: null };
  const year = releaseStartYear(title);
  if (showYear !== null && year !== null && Math.abs(year - showYear) > 1) return { kind: "other", range: null };
  if (isRecut(title)) return { kind: "recut", range: range && range.last <= layout.last + ongoingSlack ? range : null };
  if (!range) return unknown;
  if (range.last > layout.last + ongoingSlack) return unknown;
  const season = statedSeason(title);
  if (season === null || season <= 1) return { kind: "series", range };
  const arcs = arcsOfSeason(layout, season);
  if (arcs.length === 0) return unknown;
  const seasonFirst = arcs[0].first;
  const seasonLast = arcs[arcs.length - 1].last;
  if (range.first >= seasonFirst && range.last <= seasonLast) return { kind: "series", range };
  const count = seasonLast - seasonFirst + 1;
  const total = statedTotal(title, title.search(String(range.last)));
  if (range.last <= count && (total === null || total === count)) {
    return { kind: "series", range: { first: seasonFirst + range.first - 1, last: seasonFirst + range.last - 1 } };
  }
  return unknown;
}

export function overlaps(range: Coverage, wanted: Coverage): boolean {
  return range.first <= wanted.last && range.last >= wanted.first;
}

export function slotOf(layout: EpisodeLayout, episode: number): { season: number; episode: number } | null {
  const arc = arcOf(layout, episode);
  return arc ? { season: arc.season, episode } : null;
}

const fileNoise = /\b(\d{3,4}[pi]|[xh]\.?26[45]|hevc|avc|\d{1,2}bit|(19|20)\d{2}|\d\.\d|aac\d?|ac3|e-?ac3|dts|mp3|flac|opus|\d+ch|\d+kbps|web-?dl|webrip|bdrip|hdtv)\b/gi;

export function longEpisodeOf(path: string, layout: EpisodeLayout): { season: number | null; episode: number } | null {
  const file = (path.replace(/\\/g, "/").split("/").pop() ?? "").replace(/\.[a-z0-9]{2,4}$/i, "");
  const limit = layout.last + ongoingSlack;
  const fits = (value: number) => value >= 1 && value <= limit;
  const full = /s(\d{1,2})[ ._-]*e(\d{1,4})(?!\d)/i.exec(file);
  if (full && fits(Number(full[2]))) return { season: Number(full[1]), episode: Number(full[2]) };
  const labelled = /(?:episode|серия|эпизод|\bep|\be)[ ._-]*(\d{1,4})(?!\d)/i.exec(file);
  if (labelled && fits(Number(labelled[1]))) return { season: null, episode: Number(labelled[1]) };
  const dashed = / [-–] (\d{1,4})(?:v\d)?(?=[ ._\[(]|$)/.exec(file);
  if (dashed && fits(Number(dashed[1]))) return { season: null, episode: Number(dashed[1]) };
  const cleaned = file.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(fileNoise, " ");
  for (const found of cleaned.matchAll(/(?:^|[ ._-])(\d{1,4})(?=[ ._-]|$)/g)) {
    const value = Number(found[1]);
    if (fits(value)) return { season: null, episode: value };
  }
  return null;
}

export function resolveLongEpisodes(
  paths: string[],
  layout: EpisodeLayout,
  coverage: Coverage | null = null,
): ({ season: number; episode: number } | null)[] {
  const guesses = paths.map((path) => longEpisodeOf(path, layout));
  const absolute = guesses.map((guess) => {
    if (!guess) return null;
    if (guess.season !== null && guess.season > 1) {
      const arcs = arcsOfSeason(layout, guess.season);
      const first = arcs[0]?.first;
      const last = arcs[arcs.length - 1]?.last;
      if (first !== undefined && last !== undefined && guess.episode <= last - first + 1 && guess.episode < first) {
        return first + guess.episode - 1;
      }
    }
    return guess.episode;
  });
  const numbers = absolute.filter((value): value is number => value !== null);
  const span = coverage ? coverage.last - coverage.first + 1 : 0;
  const shift =
    coverage && coverage.first > 1 && numbers.length > 0 && Math.max(...numbers) <= span && Math.max(...numbers) < coverage.first
      ? coverage.first - 1
      : 0;
  return absolute.map((value) => (value === null ? null : slotOf(layout, value + shift)));
}
