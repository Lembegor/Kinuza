import { create } from "zustand";
import { backend, type TorrentFile, type TorrentView } from "../lib/backend";
import { report } from "../lib/journal";

const pollIntervalMs = 1500;
const historySamples = 200;

export interface SpeedSample {
  down: number;
  up: number;
}

interface TorrentsState {
  list: TorrentView[];
  byHash: Record<string, TorrentView>;
  history: Record<string, SpeedSample[]>;
  refresh: () => Promise<void>;
}

export const useTorrents = create<TorrentsState>((set) => ({
  list: [],
  byHash: {},
  history: {},

  async refresh() {
    try {
      const list = await backend.listTorrents();
      set((state) => {
        const history: Record<string, SpeedSample[]> = {};
        for (const torrent of list) {
          const known = state.history[torrent.infoHash] ?? [];
          history[torrent.infoHash] = [...known, { down: torrent.downloadSpeed, up: torrent.uploadSpeed }].slice(-historySamples);
        }
        return { list, byHash: Object.fromEntries(list.map((torrent) => [torrent.infoHash, torrent])), history };
      });
    } catch (error) {
      report("downloads", "journal.torrents.refresh", error);
    }
  },
}));

export function isDownload(torrent: TorrentView): boolean {
  return torrent.state !== "parked" && torrent.files.some((file) => file.included);
}

export function isActiveDownload(torrent: TorrentView): boolean {
  return isDownload(torrent) && !torrent.finished && torrent.state !== "paused";
}

export function startTorrentPolling(): () => void {
  const tick = () => {
    if (document.visibilityState === "visible") void useTorrents.getState().refresh();
  };
  tick();
  const timer = setInterval(tick, pollIntervalMs);
  return () => clearInterval(timer);
}

export function fileOf(torrent: TorrentView | undefined, fileIndex: number): TorrentFile | undefined {
  return torrent?.files.find((file) => file.index === fileIndex);
}

export function fileProgress(torrent: TorrentView | undefined, fileIndex: number): number {
  const file = fileOf(torrent, fileIndex);
  if (!file || file.length === 0) return 0;
  return Math.min(1, file.downloaded / file.length);
}

export function torrentProgress(torrent: TorrentView): number {
  return torrent.totalBytes > 0 ? Math.min(1, torrent.progressBytes / torrent.totalBytes) : 0;
}

export function etaSeconds(torrent: TorrentView): number {
  if (torrent.downloadSpeed <= 0 || torrent.finished) return 0;
  return (torrent.totalBytes - torrent.progressBytes) / torrent.downloadSpeed;
}
