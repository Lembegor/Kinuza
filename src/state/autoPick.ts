import { create } from "zustand";
import { backend, type TorrentPreview } from "../lib/backend";
import { releaseCoverage, type EpisodeLayout } from "../lib/episodeLayout";
import { buildEpisodeRows, mainVideoFile } from "../lib/episodeRows";
import { currentLanguage, currentLocale } from "../lib/i18n";
import { releaseVoices, voicesSummary, type ReleaseVoice } from "../lib/trackNames";
import { isVideoRelease, originalLanguageMark, parseSize, parseTags, parseTrackerRelease, qualityRank, type TrackerRelease } from "../lib/parse";
import { pictureMarks, sourceKind } from "../lib/releaseNames";
import { toSource } from "../lib/releaseUpdate";
import { rutracker, rutrackerErrors, serverProblemOf, isServerError, type RutrackerItem, type ServerProblem } from "../lib/rutracker";
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
const extraSearches = 2;
const enoughCandidates = 2;
const defaultResolution = 1080;
const weights = { resolution: 1.5, audio: 2, subtitles: 1.2, seeds: 1.4, voice: 3, speed: 2 };

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
}

const noNames: OtherNames = { shows: [], seasons: {} };
const otherNames = new Map<string, Promise<OtherNames>>();

function namesFor(target: PickTarget): Promise<OtherNames> {
  const key = titleKey(target.title.type, target.title.id);
  const known = otherNames.get(key);
  if (known) return known;
  const task: Promise<OtherNames> =
    target.title.type === "tv"
      ? tmdb.showNames(target.title.id, "en-US").then((names) => ({
          shows: names.name ? [names.name] : [],
          seasons: Object.fromEntries(Object.entries(names.seasons).map(([number, name]) => [Number(number), name ? [name] : []])),
        }))
      : tmdb.movieTitle(target.title.id, "en-US").then((name) => ({ shows: name ? [name] : [], seasons: {} }));
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
    animeParts: null,
    label: (season) => String(season.seasonNumber),
    currentYear: new Date().getFullYear(),
  });
}

function fitsTarget(item: RutrackerItem, release: TrackerRelease, target: PickTarget, profiles: SeasonProfile[]): boolean {
  if (!isVideoRelease(release) || item.seeds <= 0) return false;
  if (target.title.type === "movie") return !target.title.year || item.title.includes(target.title.year);
  const season = target.season;
  if (season === undefined) return false;
  const year = Number(target.title.year) || null;
  if (target.layout && target.episode !== undefined && target.layout.seasons.includes(season)) {
    const coverage = releaseCoverage(item.title, target.layout, year);
    return coverage.kind === "series" && coverage.range !== null && coverage.range.first <= target.episode && coverage.range.last >= target.episode;
  }
  if (release.scope === null && !seriesMark.test(item.title)) return false;
  const match = matchSeasons(item.title, profiles, target.anime ?? false);
  if (match) return match.seasons.includes(season) && match.seasons.length <= 2;
  const stated = statedSeasons(item.title) ?? tvSeasons(item.title) ?? release.scope?.seasons ?? null;
  if (stated) return stated[0] <= season && season <= stated[1];
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

function score(item: RutrackerItem, release: TrackerRelease, sizeBytes: number, target: PickTarget): number {
  const settings = useSettings.getState();
  const wantedResolution = settings.preferredQuality > 0 ? settings.preferredQuality : defaultResolution;
  const rank = qualityRank(release.resolution || release.quality);
  const resolutionFit = rank > 0 ? -Math.abs(Math.log2(rank / wantedResolution)) : -1.5;
  const wantedAudio = settings.audioLanguage || currentLanguage();
  const wantedSubtitles = settings.subtitleLanguage || currentLanguage();
  const audio = release.audioLanguages.map((code) => (code === originalLanguageMark ? (target.originalLanguage ?? "") : code));
  const understood = audio.includes(wantedAudio) ? weights.audio : release.subtitleLanguages.includes(wantedSubtitles) ? weights.subtitles : 0;
  const seeded = item.seeds < weakSeeds ? -3 + item.seeds * 0.5 : Math.log10(item.seeds + 1) * weights.seeds;
  const preferences = useLibrary.getState().preferences[titleKey(target.title.type, target.title.id)];
  const remembered = preferences?.releaseVoice || preferences?.audioTitle;
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

function rank(items: RutrackerItem[], target: PickTarget, names: OtherNames): PickCandidate[] {
  const profiles = profilesOf(target, names);
  const seen = new Set<string>();
  return items
    .flatMap((item) => {
      if (seen.has(item.id)) return [];
      seen.add(item.id);
      const release = parseTrackerRelease(item.title);
      if (!fitsTarget(item, release, target, profiles)) return [];
      const sizeBytes = parseSize(item.size);
      const voiceTracks = releaseVoices(release, target.originalLanguage);
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
        },
      ];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, shownCandidates);
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
      },
    },
  }));
  try {
    const names = await namesFor(target);
    const first = query(target);
    let items = await rutracker.search(first, true, 0);
    let candidates = rank(items, target, names);
    const more: string[] = [];
    if (target.title.type === "tv" && target.season !== undefined) {
      const profile = profilesOf(target, names).find((item) => item.number === target.season);
      if (profile) more.push(...seasonQueries(showNamesOf(target, names), profile).map((task) => task.query));
    }
    more.push(...names.shows.map((name) => (target.title.type === "movie" && target.title.year ? `${name} ${target.title.year}` : name)));
    for (const next of [...new Set(more)].filter((text) => text.toLowerCase() !== first.toLowerCase()).slice(0, extraSearches)) {
      if (candidates.length >= enoughCandidates) break;
      items = [...items, ...(await rutracker.search(next, true, 0))];
      candidates = rank(items, target, names);
    }
    const keep = known?.byUser && candidates.some((candidate) => candidate.id === known.chosenId) ? known.chosenId : (candidates[0]?.id ?? null);
    const seen = items.map((item) => ({ id: item.id, seeds: item.seeds, sizeBytes: parseSize(item.size) }));
    patch(key, { status: candidates.length > 0 ? "ready" : "none", candidates, chosenId: keep, checkedAt: Date.now(), problem: undefined, seen });
    void backend.appLog(`autopick: ${key} found ${candidates.length} of ${items.length}, best=${candidates[0]?.id ?? "-"} seeds=${candidates[0]?.seeds ?? 0} ${candidates[0]?.resolution ?? ""}`);
    candidates.forEach((candidate, index) => {
      void backend.appLog(
        `autopick: ${key} #${index + 1} score=${candidate.score.toFixed(2)} seeds=${candidate.seeds} ${candidate.resolution || candidate.quality} ${candidate.sizeText} "${candidate.title.slice(0, 130)}"`,
      );
    });
  } catch (error) {
    const code = String(error);
    const problem = isServerError(error) ? serverProblemOf(error) : code.includes(rutrackerErrors.authRequired) ? "auth" : "failed";
    patch(key, { status: "failed", problem, checkedAt: Date.now() - freshMs + 60_000 });
    void backend.appLog(`autopick: ${key} search failed: ${code.slice(0, 120)}`);
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
  return rows.find((row) => row.season === target.season && row.episode === target.episode)?.file.index ?? null;
}

async function inspect(key: string, id: string, target: PickTarget, onDemand: boolean): Promise<Prepared | null> {
  const slot = `${key}|${id}`;
  const running = prepared.get(slot);
  if (running) return running;
  if (!onDemand && !mayPrepare()) return null;
  const task = (async () => {
    const preview = await rutracker.inspectRelease(id, true, false, torrentCacheSeconds);
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
  const downloadDir = useSettings.getState().downloadDir || null;
  await backend.addTorrent(ready.infoHash, [], downloadDir);
  const library = useLibrary.getState();
  const sources: { unitKey: string; source: Source }[] = [];
  if (target.title.type === "movie") {
    const file = ready.preview.files.find((item) => item.index === ready.fileIndex);
    if (file) sources.push({ unitKey: unitKey("movie", target.title.id), source: toSource(ready.preview, file) });
  } else if (target.season !== undefined) {
    const rows = buildEpisodeRows(ready.preview, { seasons: target.seasons, defaultSeason: target.season, layout: target.layout ?? undefined });
    for (const row of rows) {
      if (row.episode !== null) sources.push({ unitKey: unitKey("tv", target.title.id, row.season, row.episode), source: toSource(ready.preview, row.file) });
    }
    if (entry?.chosenId) {
      useReleaseWatch.getState().follow({ title: target.title, topicId: entry.chosenId, infoHash: ready.infoHash, defaultSeason: target.season });
    }
  }
  if (sources.length === 0) return null;
  library.addSources(sources);
  void backend.appLog(`autopick: ${key} committed ${ready.infoHash.slice(0, 8)} file ${ready.fileIndex}, ${sources.length} sources`);
  return ready.infoHash;
}
