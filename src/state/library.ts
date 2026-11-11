// The user's list: tracked titles with a status and a personal rating, torrent sources attached
// to movies and episodes, and watch progress.

import { create } from "zustand";
import { backend } from "../lib/backend";
import type { MediaItem, MediaType } from "../lib/tmdb";

const storeName = "library";
const saveDelayMs = 500;
const specialsSeason = 0;
/** A unit counts as watched once this share of it has been played. */
export const watchedThreshold = 0.92;
export const maxRating = 10;

export interface TitleRef {
  type: MediaType;
  id: number;
  title: string;
  poster: string | null;
  backdrop: string | null;
  year: string;
}

export type WatchStatus = "watching" | "planned" | "completed" | "onHold" | "dropped";

export const watchStatuses: { id: WatchStatus; label: string }[] = [
  { id: "watching", label: "Смотрю" },
  { id: "planned", label: "Запланировано" },
  { id: "completed", label: "Просмотрено" },
  { id: "onHold", label: "Отложено" },
  { id: "dropped", label: "Брошено" },
];

export function statusLabel(status: WatchStatus): string {
  return watchStatuses.find((item) => item.id === status)?.label ?? "";
}

export interface TrackEntry extends TitleRef {
  /** `null` when the title is only rated. */
  status: WatchStatus | null;
  /** 1..maxRating, or `null` when not rated. */
  rating: number | null;
  /** Regular episodes of a series, once known; lets the series complete itself. */
  totalEpisodes?: number;
  addedAt: number;
  updatedAt: number;
}

export interface Source {
  id: string;
  infoHash: string;
  fileIndex: number;
  fileName: string;
  size: number;
  quality: string;
  tags: string[];
  torrentName: string;
  addedAt: number;
}

export interface Progress {
  position: number;
  duration: number;
  updatedAt: number;
  title: TitleRef;
  season?: number;
  episode?: number;
  episodeName?: string;
}

type EpisodeContext = Omit<Progress, "position" | "duration" | "updatedAt">;

interface LibraryData {
  tracked: Record<string, TrackEntry>;
  sources: Record<string, Source[]>;
  progress: Record<string, Progress>;
}

/** Shape of the file written before statuses existed: bookmarks only. */
interface LegacyData {
  saved?: Record<string, TitleRef & { addedAt: number }>;
}

interface LibraryState extends LibraryData {
  loaded: boolean;
  load: () => Promise<void>;
  setStatus: (title: TitleRef, status: WatchStatus) => void;
  setRating: (title: TitleRef, rating: number | null) => void;
  removeTracked: (key: string) => void;
  /** Refreshes what is known about a tracked title when its page is opened. */
  noteTitleDetails: (title: TitleRef, totalEpisodes: number | undefined) => void;
  addSources: (entries: { unitKey: string; source: Source }[]) => void;
  removeSource: (unitKey: string, sourceId: string) => void;
  removeTorrent: (infoHash: string) => void;
  setSourceQuality: (unitKey: string, sourceId: string, quality: string) => void;
  setProgress: (unitKey: string, progress: Progress) => void;
  setWatched: (unitKey: string, watched: boolean, context: EpisodeContext) => void;
  setManyWatched: (entries: { unitKey: string; context: EpisodeContext }[], watched: boolean) => void;
}

export function titleKey(type: MediaType, id: number): string {
  return `${type}:${id}`;
}

/** A playable unit: a whole movie or one episode. */
export function unitKey(type: MediaType, id: number, season?: number, episode?: number): string {
  return type === "tv" ? `tv:${id}:${season}:${episode}` : `movie:${id}`;
}

export function toTitleRef(item: MediaItem): TitleRef {
  return {
    type: item.type,
    id: item.id,
    title: item.title,
    poster: item.poster,
    backdrop: item.backdrop,
    year: item.year,
  };
}

/** Drops the tracking fields; a card would otherwise mistake the personal rating for the catalog one. */
export function entryToRef(entry: TrackEntry): TitleRef {
  const { type, id, title, poster, backdrop, year } = entry;
  return { type, id, title, poster, backdrop, year };
}

export function isWatched(progress: Progress | undefined): boolean {
  return Boolean(progress && progress.duration > 0 && progress.position / progress.duration >= watchedThreshold);
}

/** Watched regular episodes of a series (specials do not count). */
export function watchedEpisodeCount(progress: Record<string, Progress>, seriesId: number): number {
  const prefix = `tv:${seriesId}:`;
  return Object.entries(progress).filter(
    ([key, item]) => key.startsWith(prefix) && item.season !== specialsSeason && isWatched(item),
  ).length;
}

function isFinished(title: TitleRef, entry: TrackEntry | undefined, progress: Record<string, Progress>): boolean {
  if (title.type === "movie") return isWatched(progress[unitKey("movie", title.id)]);
  return Boolean(entry?.totalEpisodes && watchedEpisodeCount(progress, title.id) >= entry.totalEpisodes);
}

/**
 * Keeps the status in step with what was actually watched: watching something makes it "watching",
 * finishing it makes it "completed". A completed title stays completed on a rewatch.
 */
function withAutoStatus(
  tracked: Record<string, TrackEntry>,
  progress: Record<string, Progress>,
  title: TitleRef,
): Record<string, TrackEntry> {
  const key = titleKey(title.type, title.id);
  const entry = tracked[key];
  const now = Date.now();

  let status: WatchStatus = entry?.status ?? "watching";
  if (isFinished(title, entry, progress)) status = "completed";
  else if (status !== "completed") status = "watching";

  if (entry && entry.status === status) return tracked;
  const base: TrackEntry = entry ?? { ...title, status: null, rating: null, addedAt: now, updatedAt: now };
  return { ...tracked, [key]: { ...base, status, updatedAt: now } };
}

function migrate(data: Partial<LibraryData> & LegacyData): LibraryData {
  const progress = data.progress ?? {};
  const tracked: Record<string, TrackEntry> = { ...(data.tracked ?? {}) };

  for (const [key, item] of Object.entries(data.saved ?? {})) {
    tracked[key] ??= { ...item, status: "planned", rating: null, updatedAt: item.addedAt };
  }
  for (const item of Object.values(progress)) {
    const key = titleKey(item.title.type, item.title.id);
    const finished = item.title.type === "movie" && isWatched(item);
    tracked[key] ??= {
      ...item.title,
      status: finished ? "completed" : "watching",
      rating: null,
      addedAt: item.updatedAt,
      updatedAt: item.updatedAt,
    };
  }
  return { tracked, sources: data.sources ?? {}, progress };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave(state: LibraryData): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data: LibraryData = { tracked: state.tracked, sources: state.sources, progress: state.progress };
    backend.storeSet(storeName, JSON.stringify(data)).catch((error) => console.error("library: save failed", error));
  }, saveDelayMs);
}

export const useLibrary = create<LibraryState>((set, get) => {
  /** Applies a change and schedules a write to disk. */
  const update = (change: (state: LibraryData) => Partial<LibraryData>) => {
    set((state) => change(state));
    scheduleSave(get());
  };

  const patchEntry = (title: TitleRef, change: Partial<TrackEntry>) =>
    update((state) => {
      const key = titleKey(title.type, title.id);
      const now = Date.now();
      const base: TrackEntry = state.tracked[key] ?? { ...title, status: null, rating: null, addedAt: now, updatedAt: now };
      return { tracked: { ...state.tracked, [key]: { ...base, ...change, updatedAt: now } } };
    });

  return {
    tracked: {},
    sources: {},
    progress: {},
    loaded: false,

    async load() {
      try {
        const text = await backend.storeGet(storeName);
        set({ ...migrate(text ? JSON.parse(text) : {}), loaded: true });
      } catch (error) {
        console.error("library: load failed", error);
        set({ loaded: true });
      }
    },

    setStatus: (title, status) => patchEntry(title, { status }),
    setRating: (title, rating) => patchEntry(title, { rating }),

    removeTracked(key) {
      update((state) => {
        const tracked = { ...state.tracked };
        delete tracked[key];
        return { tracked };
      });
    },

    noteTitleDetails(title, totalEpisodes) {
      const key = titleKey(title.type, title.id);
      const entry = get().tracked[key];
      if (!entry) return;
      const unchanged = entry.totalEpisodes === totalEpisodes && entry.poster === title.poster && entry.title === title.title;
      if (unchanged) return;
      update((state) => {
        const refreshed = { ...state.tracked, [key]: { ...entry, ...title, totalEpisodes } };
        // Knowing the episode count may reveal that the series is already finished.
        const finished = isFinished(title, refreshed[key], state.progress);
        return { tracked: finished ? withAutoStatus(refreshed, state.progress, title) : refreshed };
      });
    },

    addSources(entries) {
      update((state) => {
        const sources = { ...state.sources };
        for (const { unitKey: key, source } of entries) {
          const existing = sources[key] ?? [];
          const duplicate = existing.some(
            (item) => item.infoHash === source.infoHash && item.fileIndex === source.fileIndex,
          );
          if (!duplicate) sources[key] = [...existing, source];
        }
        return { sources };
      });
    },

    removeSource(key, sourceId) {
      update((state) => {
        const sources = { ...state.sources };
        const remaining = (sources[key] ?? []).filter((source) => source.id !== sourceId);
        if (remaining.length > 0) sources[key] = remaining;
        else delete sources[key];
        return { sources };
      });
    },

    removeTorrent(infoHash) {
      update((state) => {
        const sources: Record<string, Source[]> = {};
        for (const [key, list] of Object.entries(state.sources)) {
          const remaining = list.filter((source) => source.infoHash !== infoHash);
          if (remaining.length > 0) sources[key] = remaining;
        }
        return { sources };
      });
    },

    setSourceQuality(key, sourceId, quality) {
      update((state) => {
        const list = state.sources[key];
        if (!list) return {};
        return {
          sources: {
            ...state.sources,
            [key]: list.map((source) => (source.id === sourceId ? { ...source, quality } : source)),
          },
        };
      });
    },

    setProgress(key, progress) {
      update((state) => {
        const next = { ...state.progress, [key]: progress };
        return { progress: next, tracked: withAutoStatus(state.tracked, next, progress.title) };
      });
    },

    setWatched(key, watched, context) {
      get().setManyWatched([{ unitKey: key, context }], watched);
    },

    setManyWatched(entries, watched) {
      if (entries.length === 0) return;
      update((state) => {
        const progress = { ...state.progress };
        const now = Date.now();
        for (const { unitKey: key, context } of entries) {
          if (watched) progress[key] = { ...context, position: 1, duration: 1, updatedAt: now };
          else delete progress[key];
        }
        const tracked = watched ? withAutoStatus(state.tracked, progress, entries[0].context.title) : state.tracked;
        return { progress, tracked };
      });
    },
  };
});
