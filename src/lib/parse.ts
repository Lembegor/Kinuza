// Reads quality, season and episode numbers out of release and file names.

import type { SeasonInfo } from "./tmdb";

const videoExtensions = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv)$/i;
const subtitleExtensions = /\.(srt|ass|ssa|vtt)$/i;
const sampleMarker = /(^|[\\/._ -])sample([\\/._ -]|$)/i;

export function isVideoFile(path: string): boolean {
  return videoExtensions.test(path) && !sampleMarker.test(path);
}

export function isSubtitleFile(path: string): boolean {
  return subtitleExtensions.test(path);
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Vertical resolution used to sort sources; 0 when the name does not say. */
export function qualityRank(quality: string): number {
  return Number.parseInt(quality, 10) || 0;
}

export function parseQuality(name: string): string {
  if (/\b(2160p|4k|uhd)\b/i.test(name)) return "2160p";
  if (/\b1440p\b/i.test(name)) return "1440p";
  if (/\b1080[pi]\b/i.test(name)) return "1080p";
  if (/\b720p\b/i.test(name)) return "720p";
  if (/\b(480p|dvdrip|sd)\b/i.test(name)) return "480p";
  return "";
}

const tagPatterns: [RegExp, string][] = [
  [/\b(dv|dolby[ .]?vision)\b/i, "Dolby Vision"],
  [/\bhdr(10)?(\+|plus)?\b/i, "HDR"],
  [/\b(remux)\b/i, "Remux"],
  [/\b(blu-?ray|bdrip|bd-?rip|brrip)\b/i, "BluRay"],
  [/\b(web-?dl|webrip|web)\b/i, "WEB"],
  [/\b(hevc|[xh]\.?265)\b/i, "HEVC"],
  [/\bav1\b/i, "AV1"],
];

export function parseTags(name: string): string[] {
  return tagPatterns.filter(([pattern]) => pattern.test(name)).map(([, tag]) => tag);
}

/** What a tracker release title says about the copy: picture, voice-overs, subtitles. */
export interface TrackerRelease {
  /** The title's name without director, year or release details. */
  name: string;
  /** Release type, e.g. "BDRip" or "WEB-DL"; empty when the title does not say. */
  quality: string;
  /** Vertical resolution, e.g. "1080p"; empty when the title does not say (the topic page may). */
  resolution: string;
  /** Which part of a series the release holds; null for films. */
  scope: ReleaseScope | null;
  /** Extras worth a badge: HDR, IMAX, an extended cut. */
  tags: string[];
  /** Sound tracks in the order the release lists them. */
  audio: ReleaseAudioTrack[];
  /**
   * One entry per subtitle track: its languages as the release writes them ("Rus, Eng"), empty
   * when it names none. Null when the release lists no subtitles.
   */
  subtitles: string[] | null;
  /**
   * Two-letter codes of the languages the sound comes in. `originalLanguageMark` stands for
   * "whatever the film was made in" when the release has the original track but does not name it.
   */
  audioLanguages: string[];
  subtitleLanguages: string[];
}

export type VoiceKind = "dub" | "mvo" | "dvo" | "avo" | "vo" | "original";

/** One sound track of a release, taken apart so the interface can word it in its own language. */
export interface ReleaseAudioTrack {
  /** The kind of voice-over; null for a track the release does not label with one (a bare "Ukr", a studio name). */
  kind: VoiceKind | null;
  /** How many tracks of this kind the release has, when it says ("2x MVO"); null when it does not. */
  count: number | null;
  /** What follows the kind: studios or the language, e.g. "HDrezka, WinMedia". Empty when nothing does. */
  detail: string;
  /** The track exactly as the release writes it. */
  raw: string;
}

/** The seasons and episodes a series release holds. */
export interface ReleaseScope {
  /** First and last season, inclusive; null when the title does not say. */
  seasons: [number, number] | null;
  /** `range` is the episodes present ("1–10"), `total` how many the season has ("10", or "?" marks when unknown). */
  episodes: { range: string; total: string } | null;
}

/** In `TrackerRelease.audioLanguages`: the release has the original sound, in a language it does not name. */
export const originalLanguageMark = "original";

/** Language names as releases abbreviate them. */
const namedLanguages: [RegExp, string][] = [
  [/\b(rus|ru)\b|рус/i, "ru"],
  [/\b(ukr|ua)\b|укр/i, "uk"],
  [/\b(eng|en)\b|англ/i, "en"],
  [/\b(jap|jpn)\b|япон/i, "ja"],
];

function languagesNamedIn(text: string): string[] {
  return namedLanguages.filter(([pattern]) => pattern.test(text)).map(([, code]) => code);
}

/** On this tracker a voice-over is Russian unless the release says otherwise. */
const defaultVoiceLanguage = "ru";

const releaseTypePattern =
  /\b([a-z]*-?remux|blu-?ray|bd-?rip|web-?dl(-?rip)?|web-?rip|hd-?rip|hdtv(-?rip)?|dvd-?rip|dvd[59]|sat-?rip|tv-?rip|telesync|telecine|cam-?rip)\b/i;
const statedResolutionPattern = /\b\d{3,4}[pi]\b/i;
const yearPattern = /\b(19|20)\d{2}\b/;
const longestTag = 28;

/** Voice-over abbreviations used in release titles. */
const voiceKinds: [RegExp, VoiceKind][] = [
  [/^dub/i, "dub"],
  [/^mvo/i, "mvo"],
  [/^dvo/i, "dvo"],
  [/^avo/i, "avo"],
  [/^vo\b/i, "vo"],
  [/^orig/i, "original"],
];
const subtitleMarker = /^sub/i;

/** "(HDrezka, WinMedia)" or "Eng" that follows the leading keyword of a track. */
function trackDetail(track: string): string {
  return track
    .replace(/^[a-zа-яё]+\s*/i, "")
    .replace(/^\((.*)\)$/, "$1")
    .trim();
}

function readAudioTrack(track: string): ReleaseAudioTrack {
  const counted = /^(\d+)\s*[xх]\s*(.+)$/i.exec(track);
  const body = counted ? counted[2] : track;
  const kind = voiceKinds.find(([pattern]) => pattern.test(body));
  if (!kind) return { kind: null, count: null, detail: "", raw: track };
  return { kind: kind[1], count: counted ? Number(counted[1]) : null, detail: trackDetail(body), raw: track };
}

/**
 * Which seasons and episodes a release holds. Series write it as
 * "Сезон: 2 / Серии: 1-10 из 10", "Серии 1-7 (7)" or "1 сезон"; anime as "(ТВ-2)" and "[12 из 24]".
 */
function seriesScope(title: string): ReleaseScope | null {
  const season = (/сезон[ы]?\s*:?\s*(\d+(?:\s*-\s*\d+)?)/i.exec(title) ??
    /(\d+)\s*сезон/i.exec(title) ??
    /\(ТВ-(\d+)/i.exec(title))?.[1];
  const episodes =
    /сери[ияй]\s*:?\s*(\d+(?:\s*-\s*\d+)?)\s*(?:из|of)\s*(\d+|\?+)/i.exec(title) ??
    /сери[ияй]\s*:?\s*(\d+(?:\s*-\s*\d+)?)\s*\((\d+)\)/i.exec(title) ??
    /\[\s*(\d+(?:\s*-\s*\d+)?)\s*(?:из|of)\s*(\d+|\?+)\s*\]/i.exec(title);
  if (!season && !episodes) return null;
  const [firstSeason, lastSeason = firstSeason] = (season ?? "").split(/\s*-\s*/).map(Number);
  return {
    seasons: season ? [firstSeason, lastSeason] : null,
    episodes: episodes ? { range: episodes[1].replace(/\s*-\s*/, "–"), total: episodes[2] } : null,
  };
}

/**
 * Reads a tracker title. Films and series look like
 * "Name / Original / Сезон: 1 / Серии: 1-8 из 8 (Director) [year, countries, genres, BDRip 1080p] [IMAX] Dub + MVO (Studio) + Sub (Rus, Eng)",
 * anime like "Name / Original [TV] [12 из 12] [RUS(int), JAP+Sub] [2020, adventure, BDRip] [1080p]".
 * Titles of another shape (music, games) come back with only `name` filled.
 */
export function parseTrackerRelease(title: string): TrackerRelease {
  const unknown: TrackerRelease = {
    name: title.trim(),
    quality: "",
    resolution: "",
    scope: null,
    tags: [],
    audio: [],
    subtitles: null,
    audioLanguages: [],
    subtitleLanguages: [],
  };
  const detailsStart = title.indexOf("[");
  if (detailsStart < 0) return unknown;

  const rest = title.slice(detailsStart);
  const groups = [...rest.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1].trim());
  const parts = groups.map((group) => group.split(",").map((part) => part.trim()));

  const releaseGroup = parts.findIndex((group) => group.some((part) => releaseTypePattern.test(part)));
  const releaseIndex = releaseGroup >= 0 ? parts[releaseGroup].findIndex((part) => releaseTypePattern.test(part)) : -1;
  const release = releaseGroup >= 0 ? parts[releaseGroup][releaseIndex] : "";

  const statedResolution =
    statedResolutionPattern.exec(release)?.[0] ?? statedResolutionPattern.exec(groups.join(" "))?.[0] ?? "";
  const resolution = statedResolution.toLowerCase() || parseQuality(release);
  const quality = release.replace(statedResolution, "").replace(/\s+/g, " ").trim();
  const scope = seriesScope(title);

  // The group with the year and genres is not a badge; neither is one that only repeats the resolution or the scope.
  const detailsGroup = releaseGroup >= 0 ? releaseGroup : groups.findIndex((group) => yearPattern.test(group));
  const tags = [
    ...(releaseGroup >= 0 ? parts[releaseGroup].slice(releaseIndex + 1) : []),
    ...groups.filter((_, index) => index !== detailsGroup),
  ].filter(
    (tag) =>
      tag !== "" &&
      tag.length <= longestTag &&
      tag.toLowerCase() !== statedResolution.toLowerCase() &&
      !/^\d+(\s*-\s*\d+)?\s*(из|of)\s*(\d+|\?+)$/i.test(tag),
  );

  // The track list follows the group with the year and the release type; anything before that
  // group (an edition note, the director's name) is not part of it.
  const detailsText = detailsGroup >= 0 ? `[${[...rest.matchAll(/\[([^\]]*)\]/g)][detailsGroup][1]}]` : "";
  const afterDetails = detailsText ? rest.slice(rest.indexOf(detailsText) + detailsText.length) : rest;
  const tracks = afterDetails
    .replace(/\[[^\]]*\]/g, " ")
    .split(/\s*\+\s*/)
    .map((track) => track.trim())
    .filter(Boolean);
  const isSubtitles = (track: string) => subtitleMarker.test(track);
  const isVoice = (track: string) => voiceKinds.some(([pattern]) => pattern.test(track.replace(/^\d+\s*[xх]\s*/i, "")));
  // Text after the brackets is a track list only if it reads like one.
  const listsTracks = tracks.some((track) => isSubtitles(track) || isVoice(track));

  const subtitleTracks = listsTracks ? tracks.filter(isSubtitles) : [];
  const subtitles = subtitleTracks.length > 0 ? subtitleTracks.map(trackDetail) : null;

  if (!release && !resolution && !listsTracks && !scope) return unknown;

  const audioLanguages = new Set<string>();
  const subtitleLanguages = new Set<string>();
  if (listsTracks) {
    for (const track of tracks) {
      const named = languagesNamedIn(track);
      if (isSubtitles(track)) {
        // Subtitles with no language given are in the tracker's own language.
        for (const code of named.length > 0 ? named : [defaultVoiceLanguage]) subtitleLanguages.add(code);
      } else if (/^orig/i.test(track)) {
        for (const code of named.length > 0 ? named : [originalLanguageMark]) audioLanguages.add(code);
      } else if (isVoice(track)) {
        for (const code of named.length > 0 ? named : [defaultVoiceLanguage]) audioLanguages.add(code);
      } else {
        // A bare "Ukr" or "Eng" between the voice-overs is one more track in that language;
        // a studio name alone in parentheses is a voice-over whose kind was left out.
        const unnamedVoice = /^\(.+\)$/.test(track) ? [defaultVoiceLanguage] : [];
        for (const code of named.length > 0 ? named : unnamedVoice) audioLanguages.add(code);
      }
    }
  }
  // Anime releases put the languages in a group of their own: "RUS(int), ENG, JAP+Sub".
  for (const group of groups) {
    if (!/\b(rus|eng|jap|ukr)\b/i.test(group) || yearPattern.test(group)) continue;
    const [sound, subtitled] = group.split(/\+\s*sub/i);
    for (const code of languagesNamedIn(sound)) audioLanguages.add(code);
    if (subtitled !== undefined) {
      for (const code of languagesNamedIn(subtitled).length > 0 ? languagesNamedIn(subtitled) : [defaultVoiceLanguage]) {
        subtitleLanguages.add(code);
      }
    }
  }

  const head = title.slice(0, detailsStart);
  const scopeStart = head.search(/\s*\/\s*(?:\d+\s*)?сезон/i);
  return {
    name: (scopeStart > 0 ? head.slice(0, scopeStart) : head).replace(/\s*\([^()]*\)\s*$/, "").trim(),
    quality,
    resolution,
    scope,
    tags,
    audio: listsTracks ? tracks.filter((track) => !isSubtitles(track)).map(readAudioTrack) : [],
    subtitles,
    audioLanguages: [...audioLanguages],
    subtitleLanguages: [...subtitleLanguages],
  };
}

/** False for music, games and other releases whose title says nothing about picture or voice-overs. */
export function isVideoRelease(release: TrackerRelease): boolean {
  return release.quality !== "" || release.resolution !== "" || release.audio.length > 0 || release.scope !== null;
}

const sizeUnits: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

/** Bytes in a size written the tracker's way, e.g. "2.17 GB"; 0 when it cannot be read. */
export function parseSize(text: string): number {
  const match = /([\d.,]+)\s*([kmgt]?b)/i.exec(text.replace(/ /g, " "));
  if (!match) return 0;
  return Math.round(Number(match[1].replace(",", ".")) * sizeUnits[match[2].toLowerCase()]) || 0;
}

export interface EpisodeGuess {
  season: number | null;
  episode: number | null;
}

/** Tokens that look like episode numbers but are not: resolutions, codecs, years, bit depth. */
const noisePattern =
  /\b(\d{3,4}[pi]|[xh]\.?26[45]|\d{1,2}bit|(19|20)\d{2}|\d\.\d|aac\d?|ac3|dts|mp3|flac|\d+ch|\d+kbps)\b/gi;

export function parseEpisode(path: string): EpisodeGuess {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const file = (parts.pop() ?? "").replace(videoExtensions, "");
  const folders = parts.join("/");

  const folderSeason = /(?:season|сезон|\bs)[ ._-]*(\d{1,2})\b/i.exec(folders);
  const seasonFromFolder = folderSeason ? Number(folderSeason[1]) : null;

  const full = /s(\d{1,2})[ ._-]*e(\d{1,3})/i.exec(file) ?? /\b(\d{1,2})x(\d{2,3})\b/i.exec(file);
  if (full) return { season: Number(full[1]), episode: Number(full[2]) };

  const worded =
    /(?:сезон|season)[ ._-]*(\d{1,2}).*?(?:серия|эпизод|episode|ep)[ ._-]*(\d{1,3})/i.exec(file);
  if (worded) return { season: Number(worded[1]), episode: Number(worded[2]) };

  // "Season 2", "Сезон 2", "2nd Season", "2 сезон", and a bare "S2" that is not part of "S2E05".
  // A number before the word wins: in "2 сезон 07 серия" and "2nd Season - 05" the one after it is the episode.
  const fileSeason =
    /\b(\d{1,2})(?:st|nd|rd|th)[ ._-]*season|\b(\d{1,2})[ ._-]*сезон/i.exec(file)?.slice(1).find(Boolean) ??
    /(?:season|сезон)[ ._]*(\d{1,2})/i.exec(file)?.[1] ??
    /(?:^|[ ._\[(-])s(\d{1,2})(?=[ ._\])-]|$)/i.exec(file)?.[1];
  const season = fileSeason ? Number(fileSeason) : seasonFromFolder;

  // "[05 of 12]", "05 из 12": the first number is the episode.
  const counted = /(?:^|[ ._\[(-])(\d{1,3})[ ._]*(?:of|из)[ ._]*\d{1,3}(?=[ ._\])-]|$)/i.exec(file);
  if (counted) return { season, episode: Number(counted[1]) };

  const labelled = /(?:серия|эпизод|episode|ep|\be)[ ._-]*(\d{1,3})\b/i.exec(file);
  if (labelled) return { season, episode: Number(labelled[1]) };

  // Anime style: "[Group] Title - 07 [1080p]".
  const dashed = / - (\d{1,3})(?:v\d)?(?=[ ._\[(]|$)/.exec(file);
  if (dashed) return { season, episode: Number(dashed[1]) };

  const cleaned = file
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    // The season is already known; its number must not be taken for the episode.
    .replace(/(?:season|сезон)[ ._-]*\d{1,2}|\b\d{1,2}(?:st|nd|rd|th)?[ ._-]*(?:season|сезон)|(?:^|[ ._-])s\d{1,2}(?=[ ._-]|$)/gi, " ")
    .replace(noisePattern, " ");
  const standalone = /(?:^|[ ._-])(\d{1,3})(?=[ ._-]|$)/.exec(cleaned);
  return { season, episode: standalone ? Number(standalone[1]) : null };
}

export interface EpisodeSlot {
  season: number;
  episode: number;
}

/**
 * Places a guessed episode into the show's real seasons. A file with no season and a number past
 * the end of the default season is treated as absolute numbering (common for anime).
 */
export function resolveEpisode(
  guess: EpisodeGuess,
  seasons: SeasonInfo[],
  defaultSeason: number,
): EpisodeSlot | null {
  if (guess.episode === null) return null;
  if (guess.season !== null) return { season: guess.season, episode: guess.episode };

  const regular = seasons.filter((season) => season.seasonNumber > 0);
  const fallback = regular.find((season) => season.seasonNumber === defaultSeason);
  if (!fallback || guess.episode <= fallback.episodeCount) {
    return { season: defaultSeason, episode: guess.episode };
  }

  let remaining = guess.episode;
  for (const season of regular) {
    if (remaining <= season.episodeCount) return { season: season.seasonNumber, episode: remaining };
    remaining -= season.episodeCount;
  }
  return { season: defaultSeason, episode: guess.episode };
}

/** Strips release noise from a torrent name to get something searchable in the catalog. */
export function guessTitleQuery(torrentName: string): string {
  const withoutBrackets = torrentName.replace(/\[[^\]]*\]/g, " ");
  const cut = withoutBrackets.search(
    /[ ._(-]+((19|20)\d{2}|s\d{1,2}(e\d+)?|\d{3,4}[pi]|сезон|season|web|blu-?ray|bdrip|hdtv|hdrip|dvdrip|remux)\b/i,
  );
  const head = cut > 0 ? withoutBrackets.slice(0, cut) : withoutBrackets;
  return head
    .replace(videoExtensions, "")
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMagnetLink(text: string): boolean {
  return /^magnet:\?xt=urn:bt(ih|mh):[a-z0-9]+/i.test(text.trim());
}

const widthSteps: [number, string][] = [[3200, "2160p"], [2300, "1440p"], [1700, "1080p"], [1150, "720p"], [700, "480p"]];
const heightSteps: [number, string][] = [[2000, "2160p"], [1300, "1440p"], [1000, "1080p"], [700, "720p"], [440, "480p"]];
const lowestQuality = "360p";

/**
 * Names the quality of a decoded picture. Both sides are checked and the better result wins:
 * wide-screen films are cropped in height, 4:3 video is narrow.
 */
export function qualityFromSize(width: number, height: number): string {
  if (width <= 0 || height <= 0) return "";
  const byWidth = widthSteps.find(([minimum]) => width >= minimum)?.[1] ?? lowestQuality;
  const byHeight = heightSteps.find(([minimum]) => height >= minimum)?.[1] ?? lowestQuality;
  return qualityRank(byWidth) >= qualityRank(byHeight) ? byWidth : byHeight;
}
