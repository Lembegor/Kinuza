// The user's shelf: saved titles, torrent sources attached to movies and episodes, watch progress.

import { create } from "zustand";
import { backend } from "../lib/backend";
import type { MediaItem, MediaType } from "../lib/tmdb";

const storeName = "library";
const saveDelayMs = 500;
/** A unit counts as watched once this share of it has been played. */
export const watchedThreshold = 0.92;

export interface TitleRef {
  type: MediaType;
  id: number;
  title: string;
  poster: string | null;
  backdrop: string | null;
  year: string;
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

interface LibraryData {
  saved: Record<string, TitleRef & { addedAt: number }>;
  sources: Record<string, Source[]>;
  progress: Record<string, Progress>;
}

interface LibraryState extends LibraryData {
  loaded: boolean;
  load: () => Promise<void>;
  toggleSaved: (title: TitleRef) => void;
  addSources: (entries: { unitKey: string; source: Source }[]) => void;
  removeSource: (unitKey: string, sourceId: string) => void;
  removeTorrent: (infoHash: string) => void;
  setProgress: (unitKey: string, progress: Progress) => void;
  setWatched: (unitKey: string, watched: boolean, context: Omit<Progress, "position" | "duration" | "updatedAt">) => void;
  clearProgress: (unitKey: string) => void;
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

export function isWatched(progress: Progress | undefined): boolean {
  return Boolean(progress && progress.duration > 0 && progress.position / progress.duration >= watchedThreshold);
}

const emptyData: LibraryData = { saved: {}, sources: {}, progress: {} };

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave(state: LibraryData): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data: LibraryData = { saved: state.saved, sources: state.sources, progress: state.progress };
    backend.storeSet(storeName, JSON.stringify(data)).catch((error) => console.error("library: save failed", error));
  }, saveDelayMs);
}

export const useLibrary = create<LibraryState>((set, get) => {
  /** Applies a change and schedules a write to disk. */
  const update = (change: (state: LibraryData) => Partial<LibraryData>) => {
    set((state) => change(state));
    scheduleSave(get());
  };

  return {
    ...emptyData,
    loaded: false,

    async load() {
      try {
        const text = await backend.storeGet(storeName);
        const data: Partial<LibraryData> = text ? JSON.parse(text) : {};
        set({ ...emptyData, ...data, loaded: true });
      } catch (error) {
        console.error("library: load failed", error);
        set({ loaded: true });
      }
    },

    toggleSaved(title) {
      update((state) => {
        const key = titleKey(title.type, title.id);
        const saved = { ...state.saved };
        if (saved[key]) delete saved[key];
        else saved[key] = { ...title, addedAt: Date.now() };
        return { saved };
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

    setProgress(key, progress) {
      update((state) => ({ progress: { ...state.progress, [key]: progress } }));
    },

    setWatched(key, watched, context) {
      update((state) => {
        const progress = { ...state.progress };
        if (watched) progress[key] = { ...context, position: 1, duration: 1, updatedAt: Date.now() };
        else delete progress[key];
        return { progress };
      });
    },

    clearProgress(key) {
      update((state) => {
        const progress = { ...state.progress };
        delete progress[key];
        return { progress };
      });
    },
  };
});

/** Which saved title (if any) a torrent belongs to, for the downloads screen. */
export function findUnitsByTorrent(sources: Record<string, Source[]>, infoHash: string): string[] {
  return Object.entries(sources)
    .filter(([, list]) => list.some((source) => source.infoHash === infoHash))
    .map(([key]) => key);
}
