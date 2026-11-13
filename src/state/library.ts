import { create } from "zustand";
import {
  accountDataVersion,
  dismissedRemovalKey,
  freshTombstones,
  isProgress,
  isRecord,
  isSourceList,
  isTitle,
  isTrackEntry,
  mergeAccountData,
  progressRemovalKey,
  trackedRemovalKey,
  validEntries,
  withNumbers,
  type AccountData,
  type Dismissal,
  type TitlePreferences,
  type TrackedField,
} from "../lib/account";
import { backend } from "../lib/backend";
import { t, type MessageKey } from "../lib/i18n";
import { report } from "../lib/journal";
import type { MediaItem, MediaType } from "../lib/tmdb";
import { useUi } from "./ui";
import { noteLibraryChange } from "./activity";

const storeName = "library";
const progressStoreName = "progress";
const quarantineStoreName = "library-damaged";
const pendingStoreName = "library-pending";
const shrinkRefused = "store_shrink_refused";
const beforeRestoreStoreName = "library-before-restore";
const libraryFileVersion = 3;
const saveDelayMs = 500;
const progressSaveDelayMs = 4000;
const specialsSeason = 0;
const announcedLimit = 2000;
const legacyAnnouncedKey = "kinuza.announcedEpisodes";
const legacyReleaseWatchKey = "kinuza.releaseWatch";
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
  liked?: boolean;
  totalEpisodes?: number;
  addedAt: number;
  updatedAt: number;
  fieldsUpdatedAt?: Partial<Record<TrackedField, number>>;
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
  played?: number;
}

export interface ReleaseWatch {
  title: TitleRef;
  topicId: string;
  infoHash: string;
  defaultSeason: number;
  pinnedSeason?: number;
}

type EpisodeContext = Omit<Progress, "position" | "duration" | "updatedAt">;

interface LibraryData {
  tracked: Record<string, TrackEntry>;
  sources: Record<string, Source[]>;
  progress: Record<string, Progress>;
  removed: Record<string, number>;
  preferences: Record<string, TitlePreferences>;
  dismissed: Record<string, Dismissal>;
  releaseWatches: Record<string, ReleaseWatch>;
  announcedEpisodes: string[] | null;
  onboardedAt?: number;
}

interface LegacyData {
  saved?: Record<string, TitleRef & { addedAt: number }>;
}

export type RestoreMode = "merge" | "replace";

interface LibraryState extends LibraryData {
  loaded: boolean;
  firstRun: boolean;
  unreadable: boolean;
  load: () => Promise<void>;
  setStatus: (title: TitleRef, status: WatchStatus | null) => void;
  setRating: (title: TitleRef, rating: number | null) => void;
  removeTracked: (key: string) => void;
  restoreTracked: (key: string, entry: TrackEntry) => void;
  restoreProgress: (key: string, progress: Progress) => void;
  forgetProgress: (key: string) => void;
  noteTitleDetails: (title: TitleRef, totalEpisodes: number | undefined) => void;
  addSources: (entries: { unitKey: string; source: Source }[]) => void;
  removeSource: (unitKey: string, sourceId: string) => void;
  removeTorrent: (infoHash: string) => void;
  setSourceQuality: (unitKey: string, sourceId: string, quality: string) => void;
  setProgress: (unitKey: string, progress: Progress) => void;
  setWatched: (unitKey: string, watched: boolean, context: EpisodeContext) => void;
  setManyWatched: (entries: { unitKey: string; context: EpisodeContext }[], watched: boolean) => void;
  setTitlePreferences: (title: Pick<TitleRef, "type" | "id">, change: Partial<Omit<TitlePreferences, "updatedAt">>) => void;
  dismiss: (title: TitleRef, detail?: Pick<Dismissal, "reason" | "personId" | "personName">) => void;
  restoreDismissed: (key: string) => void;
  finishOnboarding: (liked: { title: TitleRef; rating: number | null }[]) => void;
  followRelease: (watch: ReleaseWatch) => void;
  forgetRelease: (key: string) => void;
  rememberAnnounced: (ids: string[]) => void;
  exportAccountData: () => AccountData;
  mergeAccountData: (other: AccountData) => void;
  restoreAccountData: (other: AccountData, mode: RestoreMode) => Promise<void>;
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

  let status: WatchStatus = entry?.status ?? "watching";
  if (isFinished(title, entry, progress)) status = "completed";
  else if (status !== "completed") status = "watching";

  if (entry && entry.status === status) return tracked;
  if (entry) return { ...tracked, [key]: { ...entry, status } };
  const now = Date.now();
  return { ...tracked, [key]: { ...title, status, rating: null, addedAt: now, updatedAt: now } };
}

function readLegacy<T>(key: string): T | undefined {
  try {
    const text = localStorage.getItem(key);
    return text === null ? undefined : (JSON.parse(text) as T);
  } catch {
    return undefined;
  }
}

function forgetLegacy(): void {
  try {
    localStorage.removeItem(legacyAnnouncedKey);
    localStorage.removeItem(legacyReleaseWatchKey);
  } catch {
    return;
  }
}

function newestProgress(...lists: Record<string, Progress>[]): Record<string, Progress> {
  const merged: Record<string, Progress> = {};
  for (const list of lists) {
    for (const [key, item] of Object.entries(list)) {
      const known = merged[key];
      if (!known || (item.updatedAt ?? 0) > (known.updatedAt ?? 0)) merged[key] = item;
    }
  }
  return merged;
}

function migrate(raw: unknown, dropped: { count: number }): LibraryData {
  const data = (isRecord(raw) ? raw : {}) as Partial<LibraryData> & LegacyData;
  const progress = validEntries<Progress>(data.progress, isProgress, dropped);
  const tracked = validEntries<TrackEntry>(data.tracked, isTrackEntry, dropped);
  for (const [key, entry] of Object.entries(tracked)) tracked[key] = withNumbers(entry);

  for (const [key, item] of Object.entries(validEntries<TitleRef & { addedAt: number }>(data.saved, isTitle, dropped))) {
    tracked[key] ??= withNumbers({ ...item, status: "planned", rating: null, updatedAt: item.addedAt } as TrackEntry);
  }
  for (const item of Object.values(progress)) {
    const key = titleKey(item.title.type, item.title.id);
    const finished = item.title.type === "movie" && isWatched(item);
    tracked[key] ??= withNumbers({
      ...item.title,
      status: finished ? "completed" : "watching",
      rating: null,
      addedAt: item.updatedAt,
      updatedAt: item.updatedAt,
    });
  }
  const announced = Array.isArray(data.announcedEpisodes)
    ? data.announcedEpisodes.filter((item): item is string => typeof item === "string")
    : null;
  return {
    tracked,
    sources: validEntries<Source[]>(data.sources, isSourceList, dropped),
    progress,
    removed: freshTombstones(validEntries<number>(data.removed, (item) => typeof item === "number")),
    preferences: validEntries<TitlePreferences>(data.preferences, isRecord, dropped),
    dismissed: validEntries<Dismissal>(data.dismissed, isTitle, dropped),
    releaseWatches: validEntries<ReleaseWatch>(data.releaseWatches, (item) => isRecord(item) && isTitle(item.title), dropped),
    announcedEpisodes: announced,
    onboardedAt: typeof data.onboardedAt === "number" ? data.onboardedAt : undefined,
  };
}

function isEmpty(record: Record<string, unknown>): boolean {
  return Object.keys(record).length === 0;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let progressTimer: ReturnType<typeof setTimeout> | undefined;
let libraryDirty = false;
let progressDirty = false;
let savingBlocked = false;
let progressStored = false;
let saveFailureShown = false;
let legacyPending = false;
let libraryShrinkAllowed = false;
let progressShrinkAllowed = false;

function currentData(): LibraryData {
  return useLibrary.getState();
}

function blockSaving(error: unknown): void {
  savingBlocked = true;
  report("library", "journal.library.load", error);
  useUi.getState().toast(t("library.loadFailed"), "error");
}

function keepPending(): void {
  const state = currentData();
  void backend
    .storeSet(pendingStoreName, JSON.stringify({ version: libraryFileVersion, savedAt: Date.now(), ...state, progress: state.progress }))
    .catch(() => undefined);
}

function saveFailed(error: unknown): void {
  const refused = String(error).includes(shrinkRefused);
  if (refused) {
    savingBlocked = true;
    report("library", "journal.library.shrinkRefused", error);
    keepPending();
    useUi.getState().toast(t("library.shrinkRefused"), "error");
    return;
  }
  report("library", "journal.library.save", error);
  if (saveFailureShown) return;
  saveFailureShown = true;
  useUi.getState().toast(t("library.saveFailed"), "error");
}

function libraryDocument(state: LibraryData): string {
  return JSON.stringify({
    version: libraryFileVersion,
    tracked: state.tracked,
    sources: state.sources,
    progress: progressStored ? undefined : state.progress,
    removed: freshTombstones(state.removed),
    preferences: state.preferences,
    dismissed: state.dismissed,
    releaseWatches: state.releaseWatches,
    announcedEpisodes: state.announcedEpisodes,
    onboardedAt: state.onboardedAt,
  });
}

async function writeProgress(): Promise<void> {
  if (savingBlocked) {
    keepPending();
    return;
  }
  const allowShrink = progressShrinkAllowed;
  progressShrinkAllowed = false;
  progressDirty = false;
  await backend.storeSet(progressStoreName, JSON.stringify({ version: libraryFileVersion, progress: currentData().progress }), allowShrink);
  progressStored = true;
}

async function writeLibrary(): Promise<void> {
  if (savingBlocked) {
    keepPending();
    return;
  }
  try {
    if (!progressStored) await writeProgress();
    const allowShrink = libraryShrinkAllowed;
    libraryShrinkAllowed = false;
    libraryDirty = false;
    await backend.storeSet(storeName, libraryDocument(currentData()), allowShrink);
    saveFailureShown = false;
    if (legacyPending) {
      legacyPending = false;
      forgetLegacy();
    }
  } catch (error) {
    saveFailed(error);
  }
}

function scheduleSave(): void {
  libraryDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushLibrary(), saveDelayMs);
}

function scheduleProgressSave(): void {
  progressDirty = true;
  if (progressTimer !== undefined) return;
  progressTimer = setTimeout(() => {
    progressTimer = undefined;
    void flushProgress();
  }, progressSaveDelayMs);
}

function flushProgress(): Promise<void> {
  clearTimeout(progressTimer);
  progressTimer = undefined;
  if (!progressDirty) return Promise.resolve();
  return writeProgress().catch(saveFailed);
}

export async function flushLibrary(): Promise<void> {
  clearTimeout(saveTimer);
  if (!useLibrary.getState().loaded) return;
  await flushProgress();
  if (libraryDirty) await writeLibrary();
}

const libraryKeys: (keyof LibraryData)[] = [
  "tracked",
  "sources",
  "removed",
  "preferences",
  "dismissed",
  "releaseWatches",
  "announcedEpisodes",
  "onboardedAt",
];

export const useLibrary = create<LibraryState>((set, get) => {
  const update = (change: (state: LibraryData) => Partial<LibraryData>, quiet = false) => {
    const before = get();
    if (!before.loaded) {
      report("library", "journal.library.early", "a change came before the library was read and was not saved");
      return;
    }
    set((state) => change(state));
    const after = get();
    if (!quiet) noteLibraryChange(before, after, isWatched);
    if (after.progress !== before.progress) scheduleProgressSave();
    if (!progressStored && after.progress !== before.progress) scheduleSave();
    if (libraryKeys.some((key) => after[key] !== before[key])) scheduleSave();
  };

  const patchEntry = (title: TitleRef, change: Partial<Pick<TrackEntry, TrackedField>>) =>
    update((state) => {
      const key = titleKey(title.type, title.id);
      const now = Date.now();
      const base: TrackEntry = state.tracked[key] ?? { ...title, status: null, rating: null, addedAt: now, updatedAt: now };
      const stamps = { ...base.fieldsUpdatedAt };
      for (const field of Object.keys(change) as TrackedField[]) stamps[field] = now;
      return { tracked: { ...state.tracked, [key]: { ...base, ...change, fieldsUpdatedAt: stamps, updatedAt: now } } };
    });

  const replaceWith = (data: AccountData, keepSources: boolean) => {
    const current = get();
    return {
      tracked: data.tracked,
      progress: data.progress,
      removed: freshTombstones(data.removed),
      preferences: data.preferences ?? {},
      dismissed: data.dismissed ?? {},
      onboardedAt: data.onboardedAt,
      sources: keepSources || !data.sources ? current.sources : data.sources,
      releaseWatches: data.releaseWatches ?? current.releaseWatches,
      announcedEpisodes: data.announcedEpisodes ?? current.announcedEpisodes,
    };
  };

  return {
    tracked: {},
    sources: {},
    progress: {},
    removed: {},
    preferences: {},
    dismissed: {},
    releaseWatches: {},
    announcedEpisodes: null,
    onboardedAt: undefined,
    loaded: false,
    firstRun: false,
    unreadable: false,

    async load() {
      try {
        const [document, progressDocument] = await Promise.all([backend.storeGet(storeName), backend.storeGet(progressStoreName)]);
        const dropped = { count: 0 };
        const raw: unknown = document ? JSON.parse(document.text) : {};
        const data = migrate(raw, dropped);
        if (progressDocument) {
          const stored: unknown = JSON.parse(progressDocument.text);
          const separate = validEntries<Progress>(isRecord(stored) ? stored.progress : undefined, isProgress, dropped);
          data.progress = newestProgress(data.progress, separate);
          progressStored = true;
        }
        if (isEmpty(data.releaseWatches)) {
          const legacy = readLegacy<Record<string, ReleaseWatch>>(legacyReleaseWatchKey);
          if (isRecord(legacy)) {
            data.releaseWatches = validEntries<ReleaseWatch>(legacy, (item) => isRecord(item) && isTitle(item.title));
            legacyPending = true;
          }
        }
        if (data.announcedEpisodes === null) {
          const legacy = readLegacy<unknown>(legacyAnnouncedKey);
          if (Array.isArray(legacy)) {
            data.announcedEpisodes = legacy.filter((item): item is string => typeof item === "string");
            legacyPending = true;
          }
        }
        const firstRun = !data.onboardedAt && isEmpty(data.tracked) && isEmpty(data.progress);
        set({ ...data, firstRun, loaded: true, unreadable: false });
        if (dropped.count > 0 && document) {
          report("library", "journal.library.dropped", String(dropped.count));
          await backend.storeSet(quarantineStoreName, document.text).catch(() => undefined);
          useUi.getState().toast(t("library.dropped", { count: dropped.count }), "info");
        }
        if (document?.recovered) useUi.getState().toast(t("library.recovered"), "info");
        if (!progressStored || legacyPending || (isRecord(raw) && raw.version !== libraryFileVersion && document)) {
          scheduleSave();
        }
      } catch (error) {
        blockSaving(error);
        set({ loaded: true, unreadable: true });
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

    restoreTracked(key, entry) {
      update((state) => {
        const removed = { ...state.removed };
        delete removed[trackedRemovalKey(key)];
        return { tracked: { ...state.tracked, [key]: { ...entry, updatedAt: Date.now() } }, removed };
      });
    },

    forgetProgress(key) {
      if (!get().progress[key]) return;
      libraryShrinkAllowed = true;
      progressShrinkAllowed = true;
      update((state) => {
        const progress = { ...state.progress };
        delete progress[key];
        return { progress, removed: { ...state.removed, [progressRemovalKey(key)]: Date.now() } };
      });
    },

    restoreProgress(key, item) {
      update((state) => {
        const removed = { ...state.removed };
        delete removed[progressRemovalKey(key)];
        return { progress: { ...state.progress, [key]: { ...item, updatedAt: Date.now() } }, removed };
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
          const duplicate = existing.some((item) => item.infoHash === source.infoHash && item.fileIndex === source.fileIndex);
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
      if (!watched) {
        libraryShrinkAllowed = true;
        progressShrinkAllowed = true;
      }
      update((state) => {
        const progress = { ...state.progress };
        const removed = { ...state.removed };
        const now = Date.now();
        for (const { unitKey: key, context } of entries) {
          if (watched) {
            if (isWatched(progress[key])) continue;
            progress[key] = { ...context, position: 1, duration: 1, updatedAt: now };
          } else {
            const known = progress[key];
            if (!known || !isWatched(known)) continue;
            if (known.duration > 1) {
              progress[key] = { ...known, position: 0, updatedAt: now };
            } else {
              delete progress[key];
              removed[progressRemovalKey(key)] = now;
            }
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

    dismiss(title, detail) {
      update((state) => {
        const key = titleKey(title.type, title.id);
        const { type, id, title: name, poster, backdrop, year } = title;
        return {
          dismissed: { ...state.dismissed, [key]: { type, id, title: name, poster, backdrop, year, ...detail, updatedAt: Date.now() } },
        };
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
        for (const { title, rating } of liked) {
          const key = titleKey(title.type, title.id);
          tracked[key] ??= { ...title, status: null, rating, liked: true, addedAt: now, updatedAt: now };
        }
        return { tracked, onboardedAt: state.onboardedAt ?? now };
      });
    },

    followRelease(watch) {
      update((state) => ({ releaseWatches: { ...state.releaseWatches, [titleKey("tv", watch.title.id)]: watch } }));
    },

    forgetRelease(key) {
      update((state) => {
        if (!state.releaseWatches[key]) return {};
        const releaseWatches = { ...state.releaseWatches };
        delete releaseWatches[key];
        return { releaseWatches };
      });
    },

    rememberAnnounced(ids) {
      update((state) => {
        const known = state.announcedEpisodes ?? [];
        const fresh = ids.filter((id) => !known.includes(id));
        if (fresh.length === 0 && state.announcedEpisodes !== null) return {};
        return { announcedEpisodes: [...known, ...fresh].slice(-announcedLimit) };
      });
    },

    exportAccountData() {
      const { tracked, progress, removed, preferences, dismissed, onboardedAt, sources, releaseWatches, announcedEpisodes } = get();
      return {
        version: accountDataVersion,
        tracked,
        progress,
        removed: freshTombstones(removed),
        preferences,
        dismissed,
        onboardedAt,
        sources,
        releaseWatches,
        announcedEpisodes: announcedEpisodes ?? undefined,
      };
    },

    mergeAccountData(other) {
      if (savingBlocked) throw new Error("library_unreadable");
      update(() => {
        const merged = mergeAccountData(get().exportAccountData(), other);
        return {
          tracked: merged.tracked,
          progress: merged.progress,
          removed: merged.removed,
          preferences: merged.preferences,
          dismissed: merged.dismissed ?? {},
          onboardedAt: merged.onboardedAt,
          sources: merged.sources ?? get().sources,
          releaseWatches: merged.releaseWatches ?? get().releaseWatches,
          announcedEpisodes: merged.announcedEpisodes ?? get().announcedEpisodes,
        };
      }, true);
      if (get().onboardedAt) set({ firstRun: false });
    },

    async restoreAccountData(other, mode) {
      if (mode === "merge") {
        get().mergeAccountData(other);
        await flushLibrary();
        return;
      }
      if (!savingBlocked) {
        await backend.storeSet(beforeRestoreStoreName, JSON.stringify(get().exportAccountData()));
      }
      savingBlocked = false;
      progressStored = false;
      libraryShrinkAllowed = true;
      progressShrinkAllowed = true;
      update(() => replaceWith(other, false), true);
      set({ unreadable: false, firstRun: false });
      await flushLibrary();
    },
  };
});
