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
        noteSpeed(list.reduce((sum, torrent) => sum + torrent.downloadSpeed, 0));
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

const speedStoreKey = "kinuza-best-speed";
const speedMemoryMs = 14 * 86_400_000;
let bestSpeed: { value: number; at: number } | null = null;

function readBestSpeed(): { value: number; at: number } {
  if (bestSpeed) return bestSpeed;
  try {
    const saved = JSON.parse(localStorage.getItem(speedStoreKey) ?? "null") as { value?: number; at?: number } | null;
    bestSpeed = saved && typeof saved.value === "number" && typeof saved.at === "number" ? { value: saved.value, at: saved.at } : { value: 0, at: 0 };
  } catch {
    bestSpeed = { value: 0, at: 0 };
  }
  return bestSpeed;
}

function noteSpeed(speed: number): void {
  const known = readBestSpeed();
  const stale = Date.now() - known.at > speedMemoryMs;
  if (speed <= known.value && !stale) return;
  if (speed < 256 * 1024) return;
  bestSpeed = { value: speed, at: Date.now() };
  try {
    localStorage.setItem(speedStoreKey, JSON.stringify(bestSpeed));
  } catch {
    return;
  }
}

export function bestObservedSpeed(): number {
  const known = readBestSpeed();
  return Date.now() - known.at > speedMemoryMs ? 0 : known.value;
}

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
