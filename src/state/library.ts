// The user's list: tracked titles with a status and a personal rating, torrent sources attached
// to movies and episodes, and watch progress.

import { create } from "zustand";
import {
  accountDataVersion,
  dismissedRemovalKey,
  mergeAccountData,
  progressRemovalKey,
  trackedRemovalKey,
  type AccountData,
  type Dismissal,
  type TitlePreferences,
} from "../lib/account";
import { backend } from "../lib/backend";
import { t, type MessageKey } from "../lib/i18n";
import type { MediaItem, MediaType } from "../lib/tmdb";

const storeName = "library";
const saveDelayMs = 500;
const specialsSeason = 0;
/** A unit counts as watched once this share of it has been played. */
export const watchedThreshold = 0.92;
export const maxRating = 10;
/**
 * The rating a title gets when the user names it as one they like during the first-run
 * introduction: clearly liked, without claiming it is a favourite or that it was watched to the end.
 */
export const likedPickRating = 8;

export interface TitleRef {
  type: MediaType;
  id: number;
  title: string;
  poster: string | null;
  backdrop: string | null;
  year: string;
}

export type WatchStatus = "watching" | "planned" | "completed" | "onHold" | "dropped";

/** The statuses in the order they are offered; `labelKey` names the message with the status's name. */
export const watchStatuses: { id: WatchStatus; labelKey: MessageKey }[] = [
  { id: "watching", labelKey: "status.watching" },
  { id: "planned", labelKey: "status.planned" },
  { id: "completed", labelKey: "status.completed" },
  { id: "onHold", labelKey: "status.onHold" },
  { id: "dropped", labelKey: "status.dropped" },
];

/** The status's name in the interface language. */
export function statusLabel(status: WatchStatus): string {
  const key = watchStatuses.find((item) => item.id === status)?.labelKey;
  return key ? t(key) : "";
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
  /** Torrents attached to titles: this computer's, unlike the rest, which is the user's (see `AccountData`). */
  sources: Record<string, Source[]>;
  progress: Record<string, Progress>;
  /** Deletion times by `tracked:<key>` / `progress:<key>`, kept so a future sync does not undo a deletion. */
  removed: Record<string, number>;
  /** How each title is watched: voice-over, subtitles, speed, timing corrections. By `type:id`. */
  preferences: Record<string, TitlePreferences>;
  /** Recommendations the user is not interested in, by `type:id`. */
  dismissed: Record<string, Dismissal>;
  /** When the first-run introduction was finished or skipped. */
  onboardedAt?: number;
}

/** Shape of the file written before statuses existed: bookmarks only. */
interface LegacyData {
  saved?: Record<string, TitleRef & { addedAt: number }>;
}

interface LibraryState extends LibraryData {
  loaded: boolean;
  /**
   * The user has nothing yet and has not been through the introduction, so the app opens with it.
   * Decided when the data is read: titles added during the introduction must not cut it short.
   */
  firstRun: boolean;
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
  /** Remembers how the user watches this title; only the given fields change. */
  setTitlePreferences: (title: Pick<TitleRef, "type" | "id">, change: Partial<Omit<TitlePreferences, "updatedAt">>) => void;
  /** "Not interested": keeps the title out of recommendations from now on. */
  dismiss: (title: TitleRef) => void;
  /** Takes a dismissal back. */
  restoreDismissed: (key: string) => void;
  /** Ends the first-run introduction for good; `liked` are the titles the user picked in it, if any. */
  finishOnboarding: (liked: TitleRef[]) => void;
  /** Statuses, ratings and progress in the form an account would store. */
  exportAccountData: () => AccountData;
  /** Folds another copy of the user's data (another device, a server) into this one; the later change wins. */
  mergeAccountData: (other: AccountData) => void;
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
  return {
    tracked,
    sources: data.sources ?? {},
    progress,
    removed: data.removed ?? {},
    preferences: data.preferences ?? {},
    dismissed: data.dismissed ?? {},
    onboardedAt: data.onboardedAt,
  };
}

function isEmpty(record: Record<string, unknown>): boolean {
  return Object.keys(record).length === 0;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** The latest state not yet on disk; null when everything is written. */
let unsaved: LibraryData | null = null;

function write(state: LibraryData): Promise<void> {
  const data: LibraryData = {
    tracked: state.tracked,
    sources: state.sources,
    progress: state.progress,
    removed: state.removed,
    preferences: state.preferences,
    dismissed: state.dismissed,
    onboardedAt: state.onboardedAt,
  };
  return backend.storeSet(storeName, JSON.stringify(data)).catch((error) => console.error("library: save failed", error));
}

function scheduleSave(state: LibraryData): void {
  unsaved = state;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushLibrary(), saveDelayMs);
}

/** Writes pending changes now instead of after the usual delay; the app calls this before it closes. */
export function flushLibrary(): Promise<void> {
  clearTimeout(saveTimer);
  const pending = unsaved;
  unsaved = null;
  return pending ? write(pending) : Promise.resolve();
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
    removed: {},
    preferences: {},
    dismissed: {},
    onboardedAt: undefined,
    loaded: false,
    firstRun: false,

    async load() {
      try {
        const text = await backend.storeGet(storeName);
        const data = migrate(text ? JSON.parse(text) : {});
        // Someone who already keeps a list here does not need the app introduced to them.
        const firstRun = !data.onboardedAt && isEmpty(data.tracked) && isEmpty(data.progress);
        set({ ...data, firstRun, loaded: true });
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
        return { tracked, removed: { ...state.removed, [trackedRemovalKey(key)]: Date.now() } };
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
        const removed = { ...state.removed };
        const now = Date.now();
        for (const { unitKey: key, context } of entries) {
          if (watched) {
            progress[key] = { ...context, position: 1, duration: 1, updatedAt: now };
          } else {
            delete progress[key];
            removed[progressRemovalKey(key)] = now;
          }
        }
        const tracked = watched ? withAutoStatus(state.tracked, progress, entries[0].context.title) : state.tracked;
        return { progress, tracked, removed };
      });
    },

    setTitlePreferences(title, change) {
      update((state) => {
        const key = titleKey(title.type, title.id);
        return { preferences: { ...state.preferences, [key]: { ...state.preferences[key], ...change, updatedAt: Date.now() } } };
      });
    },

    dismiss(title) {
      update((state) => {
        const key = titleKey(title.type, title.id);
        const { type, id, title: name, poster, backdrop, year } = title;
        return { dismissed: { ...state.dismissed, [key]: { type, id, title: name, poster, backdrop, year, updatedAt: Date.now() } } };
      });
    },

    restoreDismissed(key) {
      update((state) => {
        if (!state.dismissed[key]) return {};
        const dismissed = { ...state.dismissed };
        delete dismissed[key];
        return { dismissed, removed: { ...state.removed, [dismissedRemovalKey(key)]: Date.now() } };
      });
    },

    finishOnboarding(liked) {
      set({ firstRun: false });
      update((state) => {
        const now = Date.now();
        const tracked = { ...state.tracked };
        for (const title of liked) {
          const key = titleKey(title.type, title.id);
          tracked[key] ??= { ...title, status: null, rating: likedPickRating, addedAt: now, updatedAt: now };
        }
        return { tracked, onboardedAt: state.onboardedAt ?? now };
      });
    },

    exportAccountData() {
      const { tracked, progress, removed, preferences, dismissed, onboardedAt } = get();
      return { version: accountDataVersion, tracked, progress, removed, preferences, dismissed, onboardedAt };
    },

    mergeAccountData(other) {
      update(() => {
        const merged = mergeAccountData(get().exportAccountData(), other);
        const { tracked, progress, removed, preferences, onboardedAt } = merged;
        return { tracked, progress, removed, preferences, dismissed: merged.dismissed ?? {}, onboardedAt };
      });
      // Data that came from elsewhere may show that the introduction is behind this user already.
      if (get().onboardedAt) set({ firstRun: false });
    },
  };
});
