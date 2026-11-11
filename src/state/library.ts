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
import { report } from "../lib/journal";
import type { MediaItem, MediaType } from "../lib/tmdb";
import { useUi } from "./ui";

const storeName = "library";
const saveDelayMs = 500;
const specialsSeason = 0;
export const watchedThreshold = 0.92;
export const maxRating = 10;
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

export const watchStatuses: { id: WatchStatus; labelKey: MessageKey }[] = [
  { id: "watching", labelKey: "status.watching" },
  { id: "planned", labelKey: "status.planned" },
  { id: "completed", labelKey: "status.completed" },
  { id: "onHold", labelKey: "status.onHold" },
  { id: "dropped", labelKey: "status.dropped" },
];

export function statusLabel(status: WatchStatus): string {
  const key = watchStatuses.find((item) => item.id === status)?.labelKey;
  return key ? t(key) : "";
}

export interface TrackEntry extends TitleRef {
  status: WatchStatus | null;
  rating: number | null;
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
  removed: Record<string, number>;
  preferences: Record<string, TitlePreferences>;
  dismissed: Record<string, Dismissal>;
  onboardedAt?: number;
}

interface LegacyData {
  saved?: Record<string, TitleRef & { addedAt: number }>;
}

interface LibraryState extends LibraryData {
  loaded: boolean;
  firstRun: boolean;
  load: () => Promise<void>;
  setStatus: (title: TitleRef, status: WatchStatus) => void;
  setRating: (title: TitleRef, rating: number | null) => void;
  removeTracked: (key: string) => void;
  noteTitleDetails: (title: TitleRef, totalEpisodes: number | undefined) => void;
  addSources: (entries: { unitKey: string; source: Source }[]) => void;
  removeSource: (unitKey: string, sourceId: string) => void;
  removeTorrent: (infoHash: string) => void;
  setSourceQuality: (unitKey: string, sourceId: string, quality: string) => void;
  setProgress: (unitKey: string, progress: Progress) => void;
  setWatched: (unitKey: string, watched: boolean, context: EpisodeContext) => void;
  setManyWatched: (entries: { unitKey: string; context: EpisodeContext }[], watched: boolean) => void;
  setTitlePreferences: (title: Pick<TitleRef, "type" | "id">, change: Partial<Omit<TitlePreferences, "updatedAt">>) => void;
  dismiss: (title: TitleRef) => void;
  restoreDismissed: (key: string) => void;
  finishOnboarding: (liked: TitleRef[]) => void;
  exportAccountData: () => AccountData;
  mergeAccountData: (other: AccountData) => void;
}

export function titleKey(type: MediaType, id: number): string {
  return `${type}:${id}`;
}

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

export function entryToRef(entry: TrackEntry): TitleRef {
  const { type, id, title, poster, backdrop, year } = entry;
  return { type, id, title, poster, backdrop, year };
}

export function isWatched(progress: Progress | undefined): boolean {
  return Boolean(progress && progress.duration > 0 && progress.position / progress.duration >= watchedThreshold);
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTitle(value: unknown): value is TitleRef {
  return isRecord(value) && (value.type === "movie" || value.type === "tv") && typeof value.id === "number";
}

function validEntries<T>(value: unknown, valid: (item: unknown) => boolean): Record<string, T> {
  if (!isRecord(value)) return {};
  const kept: Record<string, T> = {};
  for (const [key, item] of Object.entries(value)) {
    if (valid(item)) kept[key] = item as T;
  }
  return kept;
}

function isProgress(item: unknown): boolean {
  return isRecord(item) && typeof item.position === "number" && typeof item.duration === "number" && isTitle(item.title);
}

function isSourceList(item: unknown): boolean {
  return Array.isArray(item) && item.every((source) => isRecord(source) && typeof source.infoHash === "string" && typeof source.fileIndex === "number");
}

function migrate(raw: unknown): LibraryData {
  const data = (isRecord(raw) ? raw : {}) as Partial<LibraryData> & LegacyData;
  const progress = validEntries<Progress>(data.progress, isProgress);
  const tracked = validEntries<TrackEntry>(data.tracked, isTitle);

  for (const [key, item] of Object.entries(validEntries<TitleRef & { addedAt: number }>(data.saved, isTitle))) {
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
    sources: validEntries<Source[]>(data.sources, isSourceList),
    progress,
    removed: validEntries<number>(data.removed, (item) => typeof item === "number"),
    preferences: validEntries<TitlePreferences>(data.preferences, isRecord),
    dismissed: validEntries<Dismissal>(data.dismissed, isTitle),
    onboardedAt: typeof data.onboardedAt === "number" ? data.onboardedAt : undefined,
  };
}

function isEmpty(record: Record<string, unknown>): boolean {
  return Object.keys(record).length === 0;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let unsaved: LibraryData | null = null;
let savingBlocked = false;
let saveFailureShown = false;

function blockSaving(error: unknown): void {
  savingBlocked = true;
  report("library", "journal.library.load", error);
  useUi.getState().toast(t("library.loadFailed"), "error");
}

function write(state: LibraryData): Promise<void> {
  if (savingBlocked) return Promise.resolve();
  const data: LibraryData = {
    tracked: state.tracked,
    sources: state.sources,
    progress: state.progress,
    removed: state.removed,
    preferences: state.preferences,
    dismissed: state.dismissed,
    onboardedAt: state.onboardedAt,
  };
  return backend.storeSet(storeName, JSON.stringify(data)).then(
    () => {
      saveFailureShown = false;
    },
    (error) => {
      report("library", "journal.library.save", error);
      if (saveFailureShown) return;
      saveFailureShown = true;
      useUi.getState().toast(t("library.saveFailed"), "error");
    },
  );
}

function scheduleSave(state: LibraryData): void {
  unsaved = state;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushLibrary(), saveDelayMs);
}

export function flushLibrary(): Promise<void> {
  clearTimeout(saveTimer);
  const pending = unsaved;
  unsaved = null;
  return pending ? write(pending) : Promise.resolve();
}

export const useLibrary = create<LibraryState>((set, get) => {
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
        const document = await backend.storeGet(storeName);
        const data = migrate(document ? JSON.parse(document.text) : {});
        const firstRun = !data.onboardedAt && isEmpty(data.tracked) && isEmpty(data.progress);
        set({ ...data, firstRun, loaded: true });
        if (document?.recovered) useUi.getState().toast(t("library.recovered"), "info");
      } catch (error) {
        blockSaving(error);
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
      savingBlocked = false;
      update(() => {
        const merged = mergeAccountData(get().exportAccountData(), other);
        const { tracked, progress, removed, preferences, onboardedAt } = merged;
        return { tracked, progress, removed, preferences, dismissed: merged.dismissed ?? {}, onboardedAt };
      });
      if (get().onboardedAt) set({ firstRun: false });
    },
  };
});
