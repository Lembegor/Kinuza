import type { TorrentFile, TorrentPreview } from "./backend";
import { inLayout, resolveLongEpisodes } from "./episodeLayout";
import { isVideoFile, resolveEpisodes } from "./parse";
import type { AddSourceTarget } from "../state/ui";

const playerFriendly = /\.(mp4|m4v|mkv|webm|mov)$/i;

export interface EpisodeRowState {
  file: TorrentFile;
  included: boolean;
  season: number;
  episode: number | null;
}

export function videoFiles(preview: TorrentPreview): TorrentFile[] {
  const videos = preview.files.filter((file) => isVideoFile(file.path));
  return (videos.length > 0 ? videos : preview.files).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

export function mainVideoFile(preview: TorrentPreview): TorrentFile | undefined {
  const files = videoFiles(preview);
  const friendly = files.filter((file) => playerFriendly.test(file.path));
  const pool = friendly.length > 0 ? friendly : files;
  const largest = pool.reduce<TorrentFile | undefined>((best, file) => (!best || file.length > best.length ? file : best), undefined);
  if (!largest) return undefined;
  const parts = pool
    .filter((file) => file.length >= largest.length * 0.5)
    .map((file) => ({ file, part: partNumber(file.path) }))
    .filter((entry): entry is { file: TorrentFile; part: number } => entry.part !== null);
  if (parts.length < 2) return largest;
  return parts.reduce((first, entry) => (entry.part < first.part ? entry : first)).file;
}

const partPatterns = [
  /(?:^|[^\d])(\d)\s*-?\s*(?:ая|я)?\s*(?:серия|часть)/i,
  /(?:серия|часть|part|cd|disc|disk|pt)[ ._-]*(\d)(?!\d)/i,
];

function partNumber(path: string): number | null {
  const file = path.replace(/\\/g, "/").split("/").pop() ?? "";
  for (const pattern of partPatterns) {
    const found = pattern.exec(file);
    if (found) return Number(found[1]);
  }
  return null;
}

export function buildEpisodeRows(preview: TorrentPreview, target: Pick<AddSourceTarget, "seasons" | "defaultSeason" | "pinnedSeason" | "layout" | "coverage">): EpisodeRowState[] {
  const { seasons, defaultSeason, pinnedSeason, layout } = target;
  const files = videoFiles(preview);
  const paths = files.map((file) => file.path);
  const long = layout && inLayout(layout, defaultSeason) ? resolveLongEpisodes(paths, layout, target.coverage ?? null) : null;
  const slots = long && long.some((slot) => slot !== null) ? long : resolveEpisodes(paths, seasons, defaultSeason, pinnedSeason);
  return files.map((file, index) => {
    const slot = slots[index];
    return { file, included: slot !== null, season: slot?.season ?? defaultSeason, episode: slot?.episode ?? null };
  });
}
