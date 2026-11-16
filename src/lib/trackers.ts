import { isDesktop, type TorrentPreview } from "./backend";
import type { ReleaseSource, RutrackerItem } from "./rutracker";

export interface TrackerQuery {
  kind: "movie" | "tv";
  title: string;
  original: string;
  english: string;
  year: number | null;
  imdb: string;
  season: number | null;
  episode: number | null;
  anime: boolean;
  adult?: boolean;
  language: string;
}

interface ServerItem {
  source: Exclude<ReleaseSource, "rutracker">;
  id: string;
  title: string;
  name: string;
  size: string;
  sizeBytes: number;
  seeds: number;
  leeches: number;
  infoHash: string;
  magnet: string;
  page: string;
  torrent: string;
  minutes: number;
  season: number | null;
  episodeFirst: number | null;
  episodeLast: number | null;
}

export interface TrackerResults {
  items: RutrackerItem[];
  sources: Record<string, string>;
}

export const sourceNames: Record<ReleaseSource, string> = {
  rutracker: "RuTracker",
  nnm: "NNM-Club",
  yts: "YTS",
  eztv: "EZTV",
  aniliberty: "AniLiberty",
  sukebei: "Sukebei",
};

const otherSources = new Set<string>(["nnm", "yts", "eztv", "aniliberty", "sukebei"]);
const known = new Map<string, RutrackerItem>();

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isDesktop) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }
  const { mockInvoke } = await import("./backend.mock");
  return mockInvoke(command, args) as Promise<T>;
}

export function sourceOf(id: string): ReleaseSource {
  const prefix = id.split(":")[0];
  return otherSources.has(prefix) ? (prefix as ReleaseSource) : "rutracker";
}

export function isRutrackerId(id: string): boolean {
  return /^\d+$/.test(id);
}

function toItem(item: ServerItem): RutrackerItem {
  const episodes =
    item.season && item.episodeFirst !== null && item.episodeFirst !== undefined
      ? { season: item.season, first: item.episodeFirst, last: item.episodeLast ?? item.episodeFirst }
      : undefined;
  return {
    id: `${item.source}:${item.id}`,
    title: item.title,
    size: item.size,
    seeds: item.seeds,
    pageUrl: item.page,
    source: item.source,
    infoHash: item.infoHash || undefined,
    magnet: item.magnet || undefined,
    link: item.torrent || undefined,
    name: item.name,
    minutes: item.minutes || undefined,
    episodes,
  };
}

export async function searchTrackers(query: TrackerQuery): Promise<TrackerResults> {
  const answer = await call<{ items: ServerItem[]; sources: Record<string, string> }>("trackers_search", { query });
  const items = answer.items.map(toItem);
  for (const item of items) known.set(item.id, item);
  return { items, sources: answer.sources };
}

export function knownItem(id: string): RutrackerItem | undefined {
  return known.get(id);
}

export function inspectTracker(id: string): Promise<TorrentPreview> {
  const item = known.get(id);
  const source = sourceOf(id);
  const plain = id.slice(source.length + 1);
  if (!item && source === "eztv") return Promise.reject(new Error("torrent_file_unavailable"));
  const magnet = item?.magnet ?? (item?.infoHash && /^[0-9a-f]{40}$/i.test(item.infoHash) ? `magnet:?xt=urn:btih:${item.infoHash}` : null);
  return call<TorrentPreview>("trackers_inspect", { source, id: plain, link: item?.link ?? null, magnet });
}
