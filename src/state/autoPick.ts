import { create } from "zustand";
import { animeInfo, type AnimeInfo, type AnimePart } from "../lib/anilist";
import { backend, type TorrentPreview } from "../lib/backend";
import { releaseCoverage, type EpisodeLayout } from "../lib/episodeLayout";
import { buildEpisodeRows, mainVideoFile } from "../lib/episodeRows";
import { currentLanguage, currentLocale } from "../lib/i18n";
import { releaseVoices, voicesSummary, type ReleaseVoice } from "../lib/trackNames";
import { isVideoRelease, originalLanguageMark, parseEpisode, parseSize, parseTags, parseTrackerRelease, qualityRank, type TrackerRelease } from "../lib/parse";
import { pictureMarks, sourceKind } from "../lib/releaseNames";
import { namedAs } from "../lib/titleMatch";
import { audioWish, wantedAudioLanguage } from "../lib/voicePreference";
import { toSource } from "../lib/releaseUpdate";
import { rutracker, rutrackerErrors, serverProblemOf, isServerError, type ReleaseSource, type RutrackerItem, type ServerProblem } from "../lib/rutracker";
import { inspectTracker, isRutrackerId, searchTrackers, type TrackerResults } from "../lib/trackers";
import { buildProfiles, matchSeasons, seasonQueries, statedSeasons, tvSeasons, type SeasonProfile } from "../lib/seasonSearch";
import { tmdb, type SeasonInfo } from "../lib/tmdb";
import { titleKey, unitKey, useLibrary, type Source, type TitleRef } from "./library";
import { useReleaseWatch } from "./releaseWatch";
import { useSettings } from "./settings";
import { bestObservedSpeed } from "./torrents";

const freshMs = 20 * 60_000;
const torrentCacheSeconds = 6 * 3600;
const dailyPrepareLimit = 80;
const prepareCountKey = "kinuza-autopick-day";
const goodSeeds = 15;
const weakSeeds = 4;
const shownCandidates = 6;
const perSeedSpeed = 300 * 1024;
const cameraPenalty = 4;
const seriesMark = /\[[^\]]*\bTV\b[^\]]*\]|\(ТВ[-\s]?\d|сери[ияй]|сезон|эпизод|episod|season|\d\s*(?:из|of)\s*[\d?]/i;
const slowestFit = -6;
const longestEpisodeMinutes = 90;
const extraSearches = 3;
const enoughCandidates = 2;
const defaultResolution = 1080;
const weights = { resolution: 1.5, audio: 2, subtitles: 1.2, seeds: 1.4, voice: 3, speed: 2 };
const donorPenalty = 1.6;
const voicedAlternativePenalty = 1;
const donorsKept = 4;
const otherTrackersWaitMs = 15_000;
const animeNamesWaitMs = 4_000;
const sameReleaseShare = 0.003;
const shownOriginalSeedsRatio = 2;

export type PickHealth = "good" | "weak" | "poor";
export type PickStatus = "searching" | "ready" | "none" | "failed";

export interface PickCandidate {
  id: string;
  title: string;
  name: string;
  seeds: number;
  sizeText: string;
  sizeBytes: number;
  resolution: string;
  quality: string;
  voices: string;
  voiceTracks: ReleaseVoice[];
  voiceText: string;
  marks: string[];
  units: number;
  score: number;
  health: PickHealth;
  source: ReleaseSource;
  languages: string[];
  original: boolean;
  donorId: string | null;
}

export interface PickTarget {
  title: TitleRef;
  originalTitle?: string;
  originalLanguage?: string;
  seasons: SeasonInfo[];
  season?: number;
  episode?: number;
  layout?: EpisodeLayout | null;
  runtimeMinutes?: number | null;
  anime?: boolean;
}

export interface Prepared {
  infoHash: string;
  fileIndex: number;
  preview: TorrentPreview;
}

export interface PickEntry {
  status: PickStatus;
  problem?: ServerProblem | "auth";
  candidates: PickCandidate[];
  chosenId: string | null;
  byUser: boolean;
  checkedAt: number;
  preparing: boolean;
  hashes: Record<string, string>;
  seen?: { id: string; seeds: number; sizeBytes: number }[];
  donors?: PickCandidate[];
  sources?: Record<string, string>;
}

interface PickState {
  entries: Record<string, PickEntry>;
}

export const useAutoPick = create<PickState>(() => ({ entries: {} }));

const prepared = new Map<string, Promise<Prepared | null>>();
const searches = new Map<string, Promise<void>>();
const targets = new Map<string, PickTarget>();

export function pickKey(target: PickTarget): string {
  return unitKey(target.title.type, target.title.id, target.season, target.episode);
}

function patch(key: string, change: Partial<PickEntry>): void {
  useAutoPick.setState((state) => {
    const current = state.entries[key];
    if (!current) return state;
    return { entries: { ...state.entries, [key]: { ...current, ...change } } };
  });
}

export function healthOf(seeds: number): PickHealth {
  return seeds >= goodSeeds ? "good" : seeds >= weakSeeds ? "weak" : "poor";
}

function query(target: PickTarget): string {
  const original = target.originalTitle ?? "";
  const readable = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{N}\p{P}\p{Zs}]+$/u.test(original);
  const name = readable && original ? original : target.title.title;
  return target.title.type === "movie" && target.title.year ? `${name} ${target.title.year}` : name;
}

function voicesOf(release: TrackerRelease): string {
  const parts = release.audio.map((track) => track.detail || track.raw).filter(Boolean);
  return [...new Set(parts)].slice(0, 3).join(", ");
}

interface OtherNames {
  shows: string[];
  seasons: Record<number, string[]>;
  parts: AnimePart[] | null;
  adult?: boolean;
}

const noNames: OtherNames = { shows: [], seasons: {}, parts: null };
const censored = /[○◯●＊*]/;
const latinName = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\p{Zs}]+$/u;

function animeExtraNames(anime: AnimeInfo): string[] {
  const usable = (name: string) => name && !censored.test(name);
  const synonyms = anime.current.synonyms.filter((name) => usable(name) && latinName.test(name) && name.trim().split(/\s+/).length >= 2).slice(0, 3);
  return [anime.current.romaji, anime.current.english, ...synonyms].filter(usable);
}
const otherNames = new Map<string, Promise<OtherNames>>();

function animeNames(target: PickTarget): Promise<AnimeInfo | null> {
  if (!target.anime) return Promise.resolve(null);
  return animeInfo({ names: [target.originalTitle ?? "", target.title.title], type: target.title.type, year: Number(target.title.year) || null }).catch(() => null);
}

function namesFor(target: PickTarget): Promise<OtherNames> {
  const key = titleKey(target.title.type, target.title.id);
  const known = otherNames.get(key);
  if (known) return known;
  const tmdbNames: Promise<OtherNames> =
    target.title.type === "tv"
      ? tmdb.showNames(target.title.id, "en-US").then((names) => ({
          shows: names.name ? [names.name] : [],
          seasons: Object.fromEntries(Object.entries(names.seasons).map(([number, name]) => [Number(number), name ? [name] : []])),
          parts: null,
        }))
      : tmdb.movieTitle(target.title.id, "en-US").then((name) => ({ shows: name ? [name] : [], seasons: {}, parts: null }));
  const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), animeNamesWaitMs));
  const task = Promise.all([tmdbNames.catch(() => noNames), Promise.race([animeNames(target), late])]).then(([names, anime]) => {
    if (anime === "late") otherNames.delete(key);
    if (!anime || anime === "late") return names;
    const extra = animeExtraNames(anime);
    return { ...names, shows: [...new Set([...names.shows, ...extra])], parts: target.title.type === "tv" ? anime.parts : null, adult: anime.current.adult };
  });
  const safe = task.catch(() => noNames);
  otherNames.set(key, safe);
  return safe;
}

function showNamesOf(target: PickTarget, names: OtherNames): string[] {
  return [...new Set([...names.shows, target.originalTitle ?? "", target.title.title].filter(Boolean))];
}

function profilesOf(target: PickTarget, names: OtherNames): SeasonProfile[] {
  if (target.title.type !== "tv") return [];
  return buildProfiles({
    seasons: target.seasons,
    showNames: showNamesOf(target, names),
    seasonNames: names.seasons,
    animeParts: names.parts,
    label: (season) => String(season.seasonNumber),
    currentYear: new Date().getFullYear(),
  });
}

function nearYear(title: string, year: string): boolean {
  const wanted = Number(year);
  return [...title.matchAll(/\b(?:19|20)\d{2}\b/g)].some((found) => Math.abs(Number(found[0]) - wanted) <= 1);
}

function partEpisodes(release: TrackerRelease): number {
  const episodes = release.scope?.episodes;
  if (!episodes) return 0;
  const total = Number(episodes.total);
  if (total > 0) return total;
  const last = Number(episodes.range.split(/[^0-9]+/).pop());
  return last > 0 ? last : 0;
}

const partPiece = /\((?:ТВ|TV)[^)]*?(?:часть|part|cour)\s*(\d)(?!\d)/i;

function fitsAnimePart(item: RutrackerItem, release: TrackerRelease, target: PickTarget, season: number): boolean {
  const part = tvSeasons(item.title);
  const episode = target.episode;
  if (!target.anime || !part || part[0] !== part[1] || episode === undefined) return true;
  const info = target.seasons.find((entry) => entry.seasonNumber === season);
  const inPart = partEpisodes(release);
  if (!info || inPart <= 0 || inPart >= info.episodeCount) return true;
  const piece = Number(partPiece.exec(item.title)?.[1] ?? 0);
  if (part[0] > season || (part[0] === season && piece > 1)) return episode > info.episodeCount - inPart;
  if (part[0] === season) return episode <= inPart;
  return true;
}

function fitsTarget(item: RutrackerItem, release: TrackerRelease, target: PickTarget, profiles: SeasonProfile[], names: string[], loose: Looseness): boolean {
  if (!isVideoRelease(release) || item.seeds <= 0) return false;
  const byImdb = item.source === "eztv" || item.source === "yts";
  if (!byImdb && !loose.name && namedAs(item.title, names) === false) return false;
  if (item.episodes && target.title.type === "tv") {
    if (target.season !== undefined && item.episodes.season !== target.season) return false;
    const episode = target.episode;
    if (item.episodes.first > 0 && episode !== undefined && (episode < item.episodes.first || episode > item.episodes.last)) return false;
  }
  if (target.title.type === "movie") {
    if (!target.title.year) return true;
    return loose.year ? nearYear(item.title, target.title.year) : item.title.includes(target.title.year);
  }
  const season = target.season;
  if (season === undefined) return false;
  const year = Number(target.title.year) || null;
  if (target.layout && target.episode !== undefined && target.layout.seasons.includes(season)) {
    const coverage = releaseCoverage(item.title, target.layout, year);
    return coverage.kind === "series" && coverage.range !== null && coverage.range.first <= target.episode && coverage.range.last >= target.episode;
  }
  if (release.scope === null && !seriesMark.test(item.title)) return false;
  const match = matchSeasons(item.title, profiles, target.anime ?? false);
  if (match) return match.seasons.includes(season) && match.seasons.length <= 2 && fitsAnimePart(item, release, target, season);
  const stated = statedSeasons(item.title) ?? tvSeasons(item.title) ?? release.scope?.seasons ?? null;
  if (stated) return stated[0] <= season && season <= stated[1] && fitsAnimePart(item, release, target, season);
  const regular = target.seasons.filter((item) => item.seasonNumber > 0).length;
  return regular <= 1;
}

function unitsIn(item: RutrackerItem, release: TrackerRelease, target: PickTarget): number {
  if (target.title.type === "movie") return 1;
  const season = target.season;
  if (season === undefined) return 0;
  if (target.layout && target.layout.seasons.includes(season)) {
    const coverage = releaseCoverage(item.title, target.layout, Number(target.title.year) || null);
    if (coverage.range) return coverage.range.last - coverage.range.first + 1;
  }
  const [first, last] = (release.scope?.episodes?.range ?? "").split(/[^0-9]+/).map(Number);
  if (first > 0 && last >= first) return last - first + 1;
  const stated = statedSeasons(item.title) ?? tvSeasons(item.title) ?? release.scope?.seasons ?? [season, season];
  return target.seasons.filter((entry) => entry.seasonNumber >= stated[0] && entry.seasonNumber <= stated[1]).reduce((sum, entry) => sum + entry.episodeCount, 0);
}

function unitMinutes(target: PickTarget): number {
  if (target.title.type === "movie") return target.runtimeMinutes ?? 0;
  if (target.runtimeMinutes && target.runtimeMinutes <= longestEpisodeMinutes) return target.runtimeMinutes;
  return target.anime ? 24 : 45;
}

function wantedAudio(target: PickTarget): string {
  const preferences = useLibrary.getState().preferences[titleKey(target.title.type, target.title.id)];
  return wantedAudioLanguage(preferences, target.originalLanguage ?? "") || target.originalLanguage || "";
}

function audioCodes(release: TrackerRelease, target: PickTarget): string[] {
  return release.audioLanguages.map((code) => (code === originalLanguageMark ? (target.originalLanguage ?? "") : code)).filter(Boolean);
}

function streamable(candidate: { sizeBytes: number; units: number; seeds: number }, target: PickTarget): boolean {
  if (candidate.seeds < weakSeeds) return false;
  const minutes = unitMinutes(target);
  if (candidate.units <= 0 || minutes <= 0 || candidate.sizeBytes <= 0) return true;
  const needed = candidate.sizeBytes / candidate.units / (minutes * 60);
  const swarm = candidate.seeds * perSeedSpeed;
  const usual = bestObservedSpeed();
  const budget = (usual > 0 ? Math.min(usual, swarm) : swarm) * 0.7;
  return needed <= budget;
}

function rememberedVoice(target: PickTarget): string {
  const preferences = useLibrary.getState().preferences[titleKey(target.title.type, target.title.id)];
  const wish = audioWish(preferences, target.originalLanguage ?? "");
  return (preferences?.releaseVoice || preferences?.audioAuthor || (wish && !wish.original ? wish.author : "") || "").toLowerCase();
}

function donorOrder(target: PickTarget): (a: PickCandidate, b: PickCandidate) => number {
  const voice = rememberedVoice(target);
  const sounds = (candidate: PickCandidate) => (voice && candidate.title.toLowerCase().includes(voice) ? 1 : 0);
  const perUnit = (candidate: PickCandidate) => candidate.sizeBytes / Math.max(1, candidate.units);
  return (a, b) => sounds(b) - sounds(a) || perUnit(a) - perUnit(b) || b.seeds - a.seeds;
}

const longerCut = /extended|director'?s[\s.]?cut|unrated|uncut|расширенн|режисс[её]рск|полная версия/i;

function cutOf(title: string): "long" | "usual" {
  return longerCut.test(title) ? "long" : "usual";
}

function sameRelease(a: PickCandidate, b: PickCandidate): boolean {
  if (a.source === b.source || a.sizeBytes <= 0 || b.sizeBytes <= 0) return false;
  const close = Math.abs(a.sizeBytes - b.sizeBytes) <= Math.max(a.sizeBytes, b.sizeBytes) * sameReleaseShare;
  return close && a.resolution === b.resolution && a.units === b.units;
}

function score(item: RutrackerItem, release: TrackerRelease, sizeBytes: number, target: PickTarget): number {
  const settings = useSettings.getState();
  const wantedResolution = settings.preferredQuality > 0 ? settings.preferredQuality : defaultResolution;
  const rank = qualityRank(release.resolution || release.quality);
  const resolutionFit = rank > 0 ? -Math.abs(Math.log2(rank / wantedResolution)) : -1.5;
  const spoken = wantedAudio(target);
  const wantedSubtitles = settings.subtitleLanguage || currentLanguage();
  const audio = release.audioLanguages.map((code) => (code === originalLanguageMark ? (target.originalLanguage ?? "") : code));
  const understood = spoken && audio.includes(spoken) ? weights.audio : release.subtitleLanguages.includes(wantedSubtitles) ? weights.subtitles : 0;
  const seeded = item.seeds < weakSeeds ? -3 + item.seeds * 0.5 : Math.log10(item.seeds + 1) * weights.seeds;
  const preferences = useLibrary.getState().preferences[titleKey(target.title.type, target.title.id)];
  const wish = audioWish(preferences, target.originalLanguage ?? "");
  const remembered = preferences?.releaseVoice || preferences?.audioTitle || (wish && !wish.original ? wish.author : "");
  const voice = remembered && item.title.toLowerCase().includes(remembered.toLowerCase()) ? weights.voice : 0;
  let speed = 0;
  const units = unitsIn(item, release, target);
  const minutes = unitMinutes(target);
  if (units > 0 && minutes > 0 && sizeBytes > 0) {
    const needed = sizeBytes / units / (minutes * 60);
    const swarm = item.seeds * perSeedSpeed;
    const usual = bestObservedSpeed();
    const budget = (usual > 0 ? Math.min(usual, swarm) : swarm) * 0.7;
    if (needed > budget) speed = Math.max(slowestFit, -Math.log2(needed / budget) * weights.speed);
  }
  const camera = sourceKind(release.quality) === "camera" ? -cameraPenalty : 0;
  return resolutionFit * weights.resolution + understood + seeded + voice + speed + camera;
}

interface Ranked {
  candidates: PickCandidate[];
  donors: PickCandidate[];
}

interface Looseness {
  year: boolean;
  name: boolean;
}

const movieSteps: Looseness[] = [
  { year: true, name: false },
  { year: false, name: true },
];

function rank(items: RutrackerItem[], target: PickTarget, names: OtherNames): Ranked {
  const strict = rankWith(items, target, names, movieSteps[0]);
  if (strict.candidates.length > 0 || target.title.type !== "movie" || !target.title.year) return strict;
  for (const step of movieSteps.slice(1)) {
    const ranked = rankWith(items, target, names, step);
    if (ranked.candidates.length > 0) return ranked;
  }
  return strict;
}

function rankWith(items: RutrackerItem[], target: PickTarget, names: OtherNames, loose: Looseness): Ranked {
  const profiles = profilesOf(target, names);
  const titleNames = showNamesOf(target, names);
  const seen = new Set<string>();
  const wanted = wantedAudio(target);
  const needsVoice = wanted !== "" && wanted !== (target.originalLanguage ?? "");
  const fitting: PickCandidate[] = items
    .flatMap((item): PickCandidate[] => {
      if (seen.has(item.id)) return [];
      seen.add(item.id);
      const release = parseTrackerRelease(item.title);
      if (!fitsTarget(item, release, target, profiles, titleNames, loose)) return [];
      const sizeBytes = parseSize(item.size);
      const voiceTracks = releaseVoices(release, target.originalLanguage);
      const languages = audioCodes(release, target);
      return [
        {
          id: item.id,
          title: item.title,
          name: release.name,
          seeds: item.seeds,
          sizeText: item.size,
          sizeBytes,
          resolution: release.resolution,
          quality: release.quality,
          voices: voicesOf(release),
          voiceTracks,
          marks: parseTags(item.title).filter((tag) => pictureMarks.includes(tag)),
          units: unitsIn(item, release, target),
          voiceText: voicesSummary(voiceTracks, currentLocale(), useSettings.getState().audioLanguage || currentLanguage()),
          score: score(item, release, sizeBytes, target),
          health: healthOf(item.seeds),
          source: item.source ?? "rutracker",
          languages,
          original: needsVoice && languages.length > 0 && !languages.includes(wanted),
          donorId: null,
        },
      ];
    })
    .sort((a, b) => b.score - a.score);
  const unique: PickCandidate[] = [];
  for (const candidate of fitting) {
    const twin = unique.findIndex((kept) => sameRelease(kept, candidate));
    if (twin < 0) unique.push(candidate);
    else if (unique[twin].source !== "rutracker" && candidate.source === "rutracker") unique[twin] = { ...candidate, seeds: Math.max(candidate.seeds, unique[twin].seeds) };
  }
  const donors = needsVoice
    ? unique.filter((candidate) => candidate.languages.includes(wanted) && streamable(candidate, target)).sort(donorOrder(target))
    : [];
  if (needsVoice && donors.length > 0) {
    const healthyVoiced = unique.some((candidate) => candidate.languages.includes(wanted) && candidate.health !== "poor" && streamable(candidate, target));
    for (const candidate of unique) {
      if (!candidate.original) continue;
      const donor = donors.find((item) => cutOf(item.title) === cutOf(candidate.title));
      if (!donor) continue;
      candidate.donorId = donor.id;
      candidate.score += weights.audio - donorPenalty - (healthyVoiced ? voicedAlternativePenalty : 0);
    }
    unique.sort((a, b) => b.score - a.score);
  }
  const shown = unique.slice(0, shownCandidates);
  const bestShownSeeds = Math.max(0, ...shown.filter((candidate) => !candidate.original).map((candidate) => candidate.seeds));
  const strongOriginal = unique.find(
    (candidate) => candidate.donorId && !shown.includes(candidate) && candidate.seeds > bestShownSeeds * shownOriginalSeedsRatio,
  );
  if (strongOriginal && shown.length >= shownCandidates) shown[shown.length - 1] = strongOriginal;
  return { candidates: shown, donors: donors.slice(0, donorsKept) };
}

export function forgetPicks(keys: string[]): void {
  const dropped = new Set(keys);
  for (const slot of [...prepared.keys()]) if (dropped.has(slot.split("|")[0])) prepared.delete(slot);
  useAutoPick.setState((state) => ({ entries: Object.fromEntries(Object.entries(state.entries).filter(([key]) => !dropped.has(key))) }));
}

export function requestPick(target: PickTarget): Promise<void> {
  const key = pickKey(target);
  targets.set(key, target);
  const running = searches.get(key);
  if (running) return running;
  const known = useAutoPick.getState().entries[key];
  if (known && known.status !== "searching" && Date.now() - known.checkedAt < freshMs) return Promise.resolve();
  const task = search(key, target).finally(() => searches.delete(key));
  searches.set(key, task);
  return task;
}

export async function autoPlay(target: PickTarget): Promise<string | null> {
  await requestPick(target);
  const key = pickKey(target);
  if (useAutoPick.getState().entries[key]?.status !== "ready") return null;
  return commitPick(key);
}

const imdbIds = new Map<string, Promise<string>>();

function imdbOf(target: PickTarget): Promise<string> {
  const key = titleKey(target.title.type, target.title.id);
  let known = imdbIds.get(key);
  if (!known) {
    known = tmdb.imdbId(target.title.type, target.title.id).catch(() => "");
    imdbIds.set(key, known);
  }
  return known;
}

async function otherTrackers(target: PickTarget, names: OtherNames): Promise<TrackerResults | null> {
  try {
    const imdb = await imdbOf(target);
    return await searchTrackers({
      kind: target.title.type,
      title: target.title.title,
      original: target.originalTitle ?? "",
      english: names.shows.find((name) => latinName.test(name)) ?? names.shows[0] ?? "",
      year: Number(target.title.year) || null,
      imdb,
      season: target.season ?? null,
      episode: target.episode ?? null,
      anime: target.anime ?? false,
      adult: names.adult ?? false,
      language: target.originalLanguage ?? "",
    });
  } catch (error) {
    void backend.appLog(`autopick: other trackers failed: ${String(error).slice(0, 120)}`);
    return null;
  }
}

function sourcesText(results: TrackerResults | null): string {
  if (!results) return "other=failed";
  return Object.entries(results.sources)
    .map(([name, state]) => `${name}=${state}:${results.items.filter((item) => item.source === name).length}`)
    .join(" ");
}

function logCandidates(key: string, ranked: Ranked, total: number, detail: string): void {
  const best = ranked.candidates[0];
  void backend.appLog(
    `autopick: ${key} found ${ranked.candidates.length} of ${total}, best=${best?.id ?? "-"} seeds=${best?.seeds ?? 0} ${best?.resolution ?? ""} ${detail}`,
  );
  ranked.candidates.forEach((candidate, index) => {
    const donor = candidate.donorId ? ` voice from ${candidate.donorId}` : candidate.original ? " original only" : "";
    void backend.appLog(
      `autopick: ${key} #${index + 1} ${candidate.source} score=${candidate.score.toFixed(2)} seeds=${candidate.seeds} ${candidate.resolution || candidate.quality} ${candidate.sizeText}${donor} "${candidate.title.slice(0, 130)}"`,
    );
  });
}

async function search(key: string, target: PickTarget): Promise<void> {
  const known = useAutoPick.getState().entries[key];
  useAutoPick.setState((state) => ({
    entries: {
      ...state.entries,
      [key]: {
        status: "searching",
        candidates: known?.candidates ?? [],
        chosenId: known?.chosenId ?? null,
        byUser: known?.byUser ?? false,
        checkedAt: Date.now(),
        preparing: false,
        hashes: known?.hashes ?? {},
        donors: known?.donors ?? [],
        sources: known?.sources,
      },
    },
  }));
  const names = await namesFor(target);
  const others = otherTrackers(target, names);
  let items: RutrackerItem[] = [];
  let failure: unknown = null;
  try {
    const first = query(target);
    items = await rutracker.search(first, true, 0);
    let candidates = rank(items, target, names).candidates;
    const more: string[] = [];
    const titled = (name: string) => (target.title.type === "movie" && target.title.year ? `${name} ${target.title.year}` : name);
    if (target.title.type === "tv" && target.season !== undefined) {
      const profile = profilesOf(target, names).find((item) => item.number === target.season);
      if (profile) more.push(...seasonQueries(showNamesOf(target, names), profile).map((task) => task.query));
      if (!target.anime) more.push(`${first} сезон ${target.season}`);
    }
    more.push(...names.shows.map(titled), titled(target.title.title));
    const short = first.split(/[,:!?(]|\s[-–]\s/)[0].trim();
    if (target.title.type === "movie" && short.split(/\s+/).length >= 2 && short.length < first.length - 5) more.push(short);
    for (const next of [...new Set(more)].filter((text) => text.toLowerCase() !== first.toLowerCase()).slice(0, extraSearches)) {
      if (candidates.filter((candidate) => candidate.health !== "poor").length >= enoughCandidates) break;
      items = [...items, ...(await rutracker.search(next, true, 0))];
      candidates = rank(items, target, names).candidates;
    }
  } catch (error) {
    failure = error;
    void backend.appLog(`autopick: ${key} rutracker search failed: ${String(error).slice(0, 120)}`);
  }
  const waited = await Promise.race([others, new Promise<"late">((resolve) => setTimeout(() => resolve("late"), otherTrackersWaitMs))]);
  const settle = (extra: TrackerResults | null, late: boolean) => {
    const all = [...items, ...(extra?.items ?? [])];
    const ranked = rank(all, target, names);
    const current = useAutoPick.getState().entries[key];
    if (late && (!current || current.preparing || (current.byUser && current.chosenId))) return;
    if (ranked.candidates.length === 0 && failure !== null) {
      const code = String(failure);
      const problem = isServerError(failure) ? serverProblemOf(failure) : code.includes(rutrackerErrors.authRequired) ? "auth" : "failed";
      patch(key, { status: "failed", problem, checkedAt: Date.now() - freshMs + 60_000, sources: extra?.sources });
      return;
    }
    const previous = late ? current : known;
    const keep =
      previous?.byUser && ranked.candidates.some((candidate) => candidate.id === previous.chosenId) ? previous.chosenId : (ranked.candidates[0]?.id ?? null);
    const seen = all.map((item) => ({ id: item.id, seeds: item.seeds, sizeBytes: parseSize(item.size) }));
    patch(key, {
      status: ranked.candidates.length > 0 ? "ready" : "none",
      candidates: ranked.candidates,
      donors: ranked.donors,
      chosenId: keep,
      checkedAt: Date.now(),
      problem: undefined,
      seen,
      sources: extra?.sources,
    });
    logCandidates(key, ranked, all.length, `${late ? "(late) " : ""}rutracker=${failure === null ? "ok" : "failed"}:${items.length} ${sourcesText(extra)}`);
  };
  if (waited === "late") {
    settle(null, false);
    void others.then((extra) => {
      if (extra && extra.items.length > 0) settle(extra, true);
    });
  } else {
    settle(waited, false);
  }
}

function mayPrepare(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const saved = JSON.parse(localStorage.getItem(prepareCountKey) ?? "{}") as { day?: string; count?: number };
    const count = saved.day === today ? (saved.count ?? 0) : 0;
    if (count >= dailyPrepareLimit) return false;
    localStorage.setItem(prepareCountKey, JSON.stringify({ day: today, count: count + 1 }));
  } catch {
    return true;
  }
  return true;
}

function fileFor(preview: TorrentPreview, target: PickTarget): number | null {
  if (target.title.type === "movie") return mainVideoFile(preview)?.index ?? null;
  if (target.season === undefined || target.episode === undefined) return null;
  const rows = buildEpisodeRows(preview, { seasons: target.seasons, defaultSeason: target.season, layout: target.layout ?? undefined });
  const episode = target.episode;
  const exact = rows.find((row) => row.season === target.season && row.episode === episode);
  const joined = rows.find((row) => row.season === target.season && episodesOf(row).includes(episode));
  return (exact ?? joined)?.file.index ?? null;
}

function episodesOf(row: { file: { path: string }; episode: number | null }): number[] {
  if (row.episode === null) return [];
  const last = parseEpisode(row.file.path).last;
  if (last === undefined || last <= row.episode) return [row.episode];
  return Array.from({ length: last - row.episode + 1 }, (_, index) => row.episode! + index);
}

async function inspect(key: string, id: string, target: PickTarget, onDemand: boolean): Promise<Prepared | null> {
  const slot = `${key}|${id}`;
  const running = prepared.get(slot);
  if (running) return running;
  if (!onDemand && !mayPrepare()) return null;
  const task = (async () => {
    const preview = isRutrackerId(id) ? await rutracker.inspectRelease(id, true, false, torrentCacheSeconds) : await inspectTracker(id);
    const fileIndex = fileFor(preview, target);
    if (fileIndex === null) return null;
    return { infoHash: preview.infoHash, fileIndex, preview };
  })();
  prepared.set(slot, task);
  task.catch(() => prepared.delete(slot));
  return task;
}

function dropCandidate(key: string, id: string): void {
  const entry = useAutoPick.getState().entries[key];
  if (!entry) return;
  const candidates = entry.candidates.filter((candidate) => candidate.id !== id);
  patch(key, { candidates, chosenId: candidates[0]?.id ?? null, byUser: false, status: candidates.length > 0 ? "ready" : "none" });
}

export function inspectPick(key: string, id: string): Promise<Prepared | null> {
  const target = targets.get(key);
  return target ? inspect(key, id, target, true) : Promise.resolve(null);
}

export async function preparePick(key: string, full: boolean, onDemand = false): Promise<Prepared | null> {
  const target = targets.get(key);
  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = useAutoPick.getState().entries[key];
    const id = entry?.chosenId;
    if (!target || !entry || !id) return null;
    patch(key, { preparing: true });
    try {
      const ready = await inspect(key, id, target, onDemand);
      if (ready) {
        void backend.warm(ready.infoHash, ready.fileIndex, full).catch(() => undefined);
        patch(key, { preparing: false });
        return ready;
      }
      if (!onDemand && !prepared.has(`${key}|${id}`)) {
        patch(key, { preparing: false });
        return null;
      }
      void backend.appLog(`autopick: ${key} release ${id} has no file for this unit, trying the next one`);
      dropCandidate(key, id);
    } catch (error) {
      patch(key, { preparing: false });
      if (onDemand) throw error;
      return null;
    }
  }
  patch(key, { preparing: false });
  return null;
}

export function choosePick(key: string, id: string, prepare = true): void {
  patch(key, { chosenId: id, byUser: true });
  const target = targets.get(key);
  const voice = useAutoPick.getState().entries[key]?.candidates.find((candidate) => candidate.id === id)?.voices.split(", ")[0];
  if (target && voice) useLibrary.getState().setTitlePreferences(target.title, { releaseVoice: voice });
  if (prepare) void preparePick(key, false, true).catch(() => undefined);
}

export async function commitPick(key: string): Promise<string | null> {
  const target = targets.get(key);
  if (!target) return null;
  const ready = await preparePick(key, true, true);
  if (!ready) return null;
  const entry = useAutoPick.getState().entries[key];
  if (entry?.chosenId) patch(key, { hashes: { ...entry.hashes, [entry.chosenId]: ready.infoHash } });
  const chosen = entry?.candidates.find((candidate) => candidate.id === entry.chosenId);
  const voice = chosen?.donorId ? { pickId: chosen.id, donorId: chosen.donorId } : {};
  const downloadDir = useSettings.getState().downloadDir || null;
  await backend.addTorrent(ready.infoHash, [], downloadDir);
  const library = useLibrary.getState();
  const sources: { unitKey: string; source: Source }[] = [];
  if (target.title.type === "movie") {
    const file = ready.preview.files.find((item) => item.index === ready.fileIndex);
    if (file) sources.push({ unitKey: unitKey("movie", target.title.id), source: { ...toSource(ready.preview, file), ...voice } });
  } else if (target.season !== undefined) {
    const rows = buildEpisodeRows(ready.preview, { seasons: target.seasons, defaultSeason: target.season, layout: target.layout ?? undefined });
    const own = new Set(rows.flatMap((row) => (row.episode === null ? [] : [`${row.season}:${row.episode}`])));
    for (const row of rows) {
      for (const episode of episodesOf(row)) {
        if (episode !== row.episode && own.has(`${row.season}:${episode}`)) continue;
        const unit = unitKey("tv", target.title.id, row.season, episode);
        sources.push({ unitKey: unit, source: unit === key ? { ...toSource(ready.preview, row.file), ...voice } : toSource(ready.preview, row.file) });
      }
    }
    if (entry?.chosenId && isRutrackerId(entry.chosenId)) {
      useReleaseWatch.getState().follow({ title: target.title, topicId: entry.chosenId, infoHash: ready.infoHash, defaultSeason: target.season });
    }
  }
  if (sources.length === 0) return null;
  library.addSources(sources);
  void backend.appLog(`autopick: ${key} committed ${ready.infoHash.slice(0, 8)} file ${ready.fileIndex}, ${sources.length} sources`);
  return ready.infoHash;
}
