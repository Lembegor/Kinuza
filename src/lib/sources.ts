import { qualityRank } from "./parse";
import type { Source } from "../state/library";
import { fileProgress, useTorrents } from "../state/torrents";

export function sortSources(sources: Source[]): Source[] {
  return [...sources].sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality) || b.size - a.size);
}

export function pickInitialSource(sources: Source[], preferredId: string | undefined, maxQuality: number): Source | undefined {
  const preferred = sources.find((source) => source.id === preferredId);
  if (preferred || sources.length === 0) return preferred;
  const { byHash } = useTorrents.getState();
  const isReady = (source: Source) => fileProgress(byHash[source.infoHash], source.fileIndex) >= 1;

  if (maxQuality > 0) {
    const within = sources.filter((source) => qualityRank(source.quality) <= maxQuality);
    const pool = within.length > 0 ? within : sources.slice(-1);
    const top = qualityRank(pool[0].quality);
    const sameQuality = pool.filter((source) => qualityRank(source.quality) === top);
    return sameQuality.find(isReady) ?? sameQuality[0];
  }
  return sources.find(isReady) ?? sources[0];
}
