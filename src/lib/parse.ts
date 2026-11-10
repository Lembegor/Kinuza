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

  const fileSeason = /(?:season|сезон)[ ._-]*(\d{1,2})/i.exec(file);
  const season = fileSeason ? Number(fileSeason[1]) : seasonFromFolder;

  const labelled = /(?:серия|эпизод|episode|ep|\be)[ ._-]*(\d{1,3})\b/i.exec(file);
  if (labelled) return { season, episode: Number(labelled[1]) };

  // Anime style: "[Group] Title - 07 [1080p]".
  const dashed = / - (\d{1,3})(?:v\d)?(?=[ ._\[(]|$)/.exec(file);
  if (dashed) return { season, episode: Number(dashed[1]) };

  const cleaned = file.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(noisePattern, " ");
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
