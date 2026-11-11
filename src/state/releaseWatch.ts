import { create } from "zustand";
import { backend } from "../lib/backend";
import { t, tn } from "../lib/i18n";
import { report } from "../lib/journal";
import { episodeFiles, planReleaseUpdate, toSource } from "../lib/releaseUpdate";
import { rutracker, rutrackerErrors } from "../lib/rutracker";
import { tmdb } from "../lib/tmdb";
import { newEpisodes } from "./calendar";
import { titleKey, unitKey, useLibrary, type Source, type TitleRef } from "./library";
import { useSettings } from "./settings";
import { useTorrents } from "./torrents";
import { useUi } from "./ui";

const storageKey = "kinuza.releaseWatch";

export interface ReleaseWatch {
  title: TitleRef;
  topicId: string;
  infoHash: string;
  defaultSeason: number;
}

interface ReleaseWatchState {
  watches: Record<string, ReleaseWatch>;
  follow: (watch: ReleaseWatch) => void;
  forget: (key: string) => void;
}

function readStored(): Record<string, ReleaseWatch> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    return stored && typeof stored === "object" ? (stored as Record<string, ReleaseWatch>) : {};
  } catch {
    return {};
  }
}

export const useReleaseWatch = create<ReleaseWatchState>((set, get) => {
  const save = (watches: Record<string, ReleaseWatch>) => {
    set({ watches });
    localStorage.setItem(storageKey, JSON.stringify(watches));
  };
  return {
    watches: readStored(),
    follow: (watch) => save({ ...get().watches, [titleKey("tv", watch.title.id)]: watch }),
    forget: (key) => save(Object.fromEntries(Object.entries(get().watches).filter(([existing]) => existing !== key))),
  };
});

export interface AddedEpisodes {
  title: TitleRef;
  count: number;
}

function sourcesFrom(seriesId: number, infoHash: string): { unitKey: string; source: Source }[] {
  const prefix = `tv:${seriesId}:`;
  return Object.entries(useLibrary.getState().sources)
    .filter(([key]) => key.startsWith(prefix))
    .flatMap(([key, list]) => list.filter((source) => source.infoHash === infoHash).map((source) => ({ unitKey: key, source })));
}

async function updateFromTopic(watch: ReleaseWatch): Promise<number> {
  const seriesId = watch.title.id;
  const preview = await rutracker.inspectRelease(watch.topicId, true);
  if (preview.infoHash === watch.infoHash) return 0;
  const remember = () => useReleaseWatch.getState().follow({ ...watch, infoHash: preview.infoHash });
  if (preview.alreadyAdded) {
    remember();
    return 0;
  }

  const details = await tmdb.details("tv", seriesId);
  const library = useLibrary.getState();
  const plan = planReleaseUpdate(
    sourcesFrom(seriesId, watch.infoHash),
    (season, episode) => (library.sources[unitKey("tv", seriesId, season, episode)] ?? []).length > 0,
    preview,
    episodeFiles(preview, details.seasons, watch.defaultSeason),
  );
  if (plan.added.length === 0) {
    remember();
    return 0;
  }

  await useTorrents.getState().refresh();
  const previous = useTorrents.getState().byHash[watch.infoHash];
  const online = previous === undefined || !previous.files.some((file) => file.included);
  const downloadDir = useSettings.getState().downloadDir || null;
  await backend.addTorrent(preview.infoHash, online ? [] : plan.added.map(({ file }) => file.index), downloadDir);
  library.addSources(plan.added.map(({ season, episode, file }) => ({ unitKey: unitKey("tv", seriesId, season, episode), source: toSource(preview, file) })));

  const sharedWithOthers = Object.entries(library.sources).some(
    ([key, list]) => !key.startsWith(`tv:${seriesId}:`) && list.some((source) => source.infoHash === watch.infoHash),
  );
  if (online && plan.replaces && !sharedWithOthers) {
    library.addSources(plan.carried.map(({ unitKey: key, file }) => ({ unitKey: key, source: toSource(preview, file) })));
    library.removeTorrent(watch.infoHash);
    if (previous !== undefined) {
      await backend.remove(watch.infoHash, true).catch((error) => report("downloads", "journal.releaseWatch.failed", error));
    }
  }
  remember();
  void useTorrents.getState().refresh();
  return plan.added.length;
}

let checking = false;

export async function checkReleaseUpdates(): Promise<AddedEpisodes[]> {
  const watches = Object.entries(useReleaseWatch.getState().watches);
  if (checking || watches.length === 0 || !useSettings.getState().autoAddEpisodes) return [];
  checking = true;
  const added: AddedEpisodes[] = [];
  try {
    const episodes = await newEpisodes();
    for (const [key, watch] of watches) {
      const { sources } = useLibrary.getState();
      const seriesId = watch.title.id;
      if (!Object.keys(sources).some((unit) => unit.startsWith(`tv:${seriesId}:`))) {
        useReleaseWatch.getState().forget(key);
        continue;
      }
      const waiting = episodes.some(
        (episode) => episode.title.id === seriesId && (sources[unitKey("tv", seriesId, episode.season, episode.episode)] ?? []).length === 0,
      );
      if (!waiting || useUi.getState().player?.title.id === seriesId) continue;
      try {
        const count = await updateFromTopic(watch);
        if (count > 0) {
          added.push({ title: watch.title, count });
          useUi.getState().toast(`${t("releaseWatch.added", { title: watch.title.title })} · ${tn("common.episodes", count)}`, "success");
        }
      } catch (error) {
        report("downloads", "journal.releaseWatch.failed", error);
        const reason = String(error);
        if (reason.includes(rutrackerErrors.authRequired) || reason.includes(rutrackerErrors.timeout)) break;
      }
    }
  } finally {
    checking = false;
  }
  return added;
}
