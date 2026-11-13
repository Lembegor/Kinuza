import type { TorrentFile, TorrentPreview } from "./backend";
import { inLayout, resolveLongEpisodes, type EpisodeLayout } from "./episodeLayout";
import { baseName, isVideoFile, parseQuality, parseTags, resolveEpisodes, type EpisodeSlot } from "./parse";
import type { SeasonInfo } from "./tmdb";
import type { Source } from "../state/library";

export function toSource(preview: Pick<TorrentPreview, "infoHash" | "name">, file: TorrentFile): Source {
  const name = baseName(file.path);
  return {
    id: `${preview.infoHash}:${file.index}`,
    infoHash: preview.infoHash,
    fileIndex: file.index,
    fileName: name,
    size: file.length,
    quality: parseQuality(name) || parseQuality(preview.name),
    tags: parseTags(`${preview.name} ${name}`),
    torrentName: preview.name,
    addedAt: Date.now(),
  };
}

export function magnetInfoHash(magnet: string): string | null {
  return /[?&]xt=urn:btih:([0-9a-f]{40})(?:&|$)/i.exec(magnet)?.[1].toLowerCase() ?? null;
}

export interface EpisodeFile {
  season: number;
  episode: number;
  file: TorrentFile;
}

export function episodeFiles(
  preview: TorrentPreview,
  seasons: SeasonInfo[],
  defaultSeason: number,
  pinnedSeason?: number,
  layout: EpisodeLayout | null = null,
): EpisodeFile[] {
  const found = new Map<string, EpisodeFile>();
  const videos = preview.files.filter((file) => isVideoFile(file.path)).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  const paths = videos.map((file) => file.path);
  const long = layout && inLayout(layout, defaultSeason) ? resolveLongEpisodes(paths, layout) : null;
  const slots = long && long.some((slot) => slot !== null) ? long : resolveEpisodes(paths, seasons, defaultSeason, pinnedSeason);
  for (const [index, file] of videos.entries()) {
    const slot = slots[index];
    if (!slot) continue;
    const key = `${slot.season}:${slot.episode}`;
    if (!found.has(key)) found.set(key, { season: slot.season, episode: slot.episode, file });
  }
  return [...found.values()];
}

export interface ReleaseUpdatePlan {
  added: EpisodeFile[];
  carried: { unitKey: string; file: TorrentFile }[];
  replaces: boolean;
}

export function planReleaseUpdate(
  current: { unitKey: string; source: Pick<Source, "fileName" | "size"> }[],
  hasSource: (season: number, episode: number) => boolean,
  preview: TorrentPreview,
  fresh: EpisodeFile[],
): ReleaseUpdatePlan {
  const carried: ReleaseUpdatePlan["carried"] = [];
  for (const { unitKey, source } of current) {
    const file = preview.files.find((candidate) => baseName(candidate.path) === source.fileName && candidate.length === source.size);
    if (file) carried.push({ unitKey, file });
  }
  return {
    added: fresh.filter(({ season, episode }) => !hasSource(season, episode)),
    carried,
    replaces: current.length > 0 && carried.length === current.length,
  };
}

export interface AttachedEpisode {
  season: number;
  episode: number;
  fileIndex: number;
}

function mostCommon(values: number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function consistentShift(attached: AttachedEpisode[], computed: Map<number, EpisodeSlot | null>): number | null {
  let shift: number | null = null;
  for (const item of attached) {
    const slot = computed.get(item.fileIndex);
    if (!slot || slot.season !== item.season) return null;
    const difference = item.episode - slot.episode;
    if (shift === null) shift = difference;
    else if (shift !== difference) return null;
  }
  return shift;
}

export function missingEpisodes(
  files: TorrentFile[],
  attached: AttachedEpisode[],
  seasons: SeasonInfo[],
  taken: (season: number, episode: number) => boolean,
  layout: EpisodeLayout | null = null,
): EpisodeFile[] {
  const videos = files.filter((file) => isVideoFile(file.path)).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  const known = new Set(attached.map((item) => item.fileIndex));
  const missing = videos.filter((file) => !known.has(file.index));
  if (missing.length === 0 || attached.length === 0) return [];
  const attachedSeasons = attached.map((item) => item.season);
  const main = mostCommon(attachedSeasons);
  const pinned = attachedSeasons.every((season) => season === main) ? main : undefined;
  const paths = videos.map((file) => file.path);
  const long = layout && inLayout(layout, main) ? resolveLongEpisodes(paths, layout) : null;
  const slots = long && long.some((slot) => slot !== null) ? long : resolveEpisodes(paths, seasons, main, pinned);
  const computed = new Map(videos.map((file, index) => [file.index, slots[index]]));
  const shift = consistentShift(attached, computed);
  if (shift === null) return [];
  const used = new Set(attached.map((item) => `${item.season}:${item.episode}`));
  const found: EpisodeFile[] = [];
  for (const file of missing) {
    const slot = computed.get(file.index);
    if (!slot) continue;
    const episode = slot.episode + shift;
    const season = seasons.find((item) => item.seasonNumber === slot.season);
    const key = `${slot.season}:${episode}`;
    if (!season || episode < 1 || episode > season.episodeCount || used.has(key) || taken(slot.season, episode)) continue;
    used.add(key);
    found.push({ season: slot.season, episode, file });
  }
  return found;
}
