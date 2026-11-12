import { backend, type TorrentFile, type TorrentView } from "../lib/backend";
import { report } from "../lib/journal";
import { isVideoFile } from "../lib/parse";
import { missingEpisodes, toSource, type AttachedEpisode } from "../lib/releaseUpdate";
import { tmdb } from "../lib/tmdb";
import { unitKey, useLibrary, type Source } from "./library";
import { useTorrents } from "./torrents";

const settleMs = 4000;

function attachedByTorrent(sources: Record<string, Source[]>): Map<string, { titleId: number; infoHash: string; attached: AttachedEpisode[] }> {
  const groups = new Map<string, { titleId: number; infoHash: string; attached: AttachedEpisode[] }>();
  for (const [key, list] of Object.entries(sources)) {
    const [type, id, season, episode] = key.split(":");
    if (type !== "tv") continue;
    const titleId = Number(id);
    const slot = { season: Number(season), episode: Number(episode) };
    if (!Number.isFinite(titleId) || !Number.isFinite(slot.season) || !Number.isFinite(slot.episode)) continue;
    for (const source of list) {
      const groupKey = `${titleId}|${source.infoHash}`;
      const group = groups.get(groupKey) ?? { titleId, infoHash: source.infoHash, attached: [] };
      group.attached.push({ ...slot, fileIndex: source.fileIndex });
      groups.set(groupKey, group);
    }
  }
  return groups;
}

async function repairTorrent(titleId: number, torrent: TorrentView, attached: AttachedEpisode[]): Promise<{ unitKey: string; source: Source }[]> {
  const known = new Set(attached.map((item) => item.fileIndex));
  if (!torrent.files.some((file) => isVideoFile(file.path) && !known.has(file.index))) return [];
  const { seasons } = await tmdb.details("tv", titleId);
  const sources = useLibrary.getState().sources;
  return missingEpisodes(torrent.files, attached, seasons, (season, episode) => (sources[unitKey("tv", titleId, season, episode)] ?? []).length > 0).map(
    (found) => ({ unitKey: unitKey("tv", titleId, found.season, found.episode), source: toSource(torrent, found.file as TorrentFile) }),
  );
}

export async function attachMissingEpisodes(): Promise<number> {
  const library = useLibrary.getState();
  if (!library.loaded) return 0;
  const torrents = useTorrents.getState().byHash;
  const additions: { unitKey: string; source: Source }[] = [];
  for (const group of attachedByTorrent(library.sources).values()) {
    const torrent = torrents[group.infoHash];
    if (!torrent || torrent.files.length === 0) continue;
    try {
      additions.push(...(await repairTorrent(group.titleId, torrent, group.attached)));
    } catch (error) {
      report("library", "journal.sources.repairFailed", error);
    }
  }
  if (additions.length > 0) {
    useLibrary.getState().addSources(additions);
    void backend.logWrite("info", `library: attached ${additions.length} more episodes from releases already added`).catch(() => undefined);
  }
  return additions.length;
}

export function scheduleSourceRepair(): () => void {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tryRun = () => {
    if (done || !useLibrary.getState().loaded || useTorrents.getState().list.length === 0) return;
    done = true;
    timer = setTimeout(() => void attachMissingEpisodes(), settleMs);
  };
  const stopLibrary = useLibrary.subscribe(tryRun);
  const stopTorrents = useTorrents.subscribe(tryRun);
  tryRun();
  return () => {
    clearTimeout(timer);
    stopLibrary();
    stopTorrents();
  };
}
