import type { TorrentFile, TorrentPreview } from "./backend";
import { baseName, isVideoFile, parseEpisode, parseQuality, parseTags, resolveEpisode } from "./parse";
import type { SeasonInfo } from "./tmdb";
import type { Source } from "../state/library";

export function toSource(preview: TorrentPreview, file: TorrentFile): Source {
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

export function episodeFiles(preview: TorrentPreview, seasons: SeasonInfo[], defaultSeason: number): EpisodeFile[] {
  const found = new Map<string, EpisodeFile>();
  const videos = preview.files.filter((file) => isVideoFile(file.path)).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  for (const file of videos) {
    const slot = resolveEpisode(parseEpisode(file.path), seasons, defaultSeason);
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
