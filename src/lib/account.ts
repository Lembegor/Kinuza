import type { Progress, ReleaseWatch, Source, TitleRef, TrackEntry } from "../state/library";

export interface TitlePreferences {
  audioLanguage?: string;
  audioTitle?: string;
  releaseVoice?: string;
  subtitleLanguage?: string;
  rate?: number;
  subtitleDelay?: number;
  audioDelay?: number;
  updatedAt: number;
}

export interface Dismissal extends TitleRef {
  updatedAt: number;
  reason?: "seen" | "genre" | "person" | "other";
  personId?: number;
  personName?: string;
}

export const accountDataVersion = 3;
export const tombstoneLifetimeMs = 90 * 24 * 60 * 60 * 1000;
export const trackedFields = ["status", "rating", "liked"] as const;
export type TrackedField = (typeof trackedFields)[number];

export interface AccountData {
  version: number;
  tracked: Record<string, TrackEntry>;
  progress: Record<string, Progress>;
  preferences: Record<string, TitlePreferences>;
  dismissed?: Record<string, Dismissal>;
  onboardedAt?: number;
  removed: Record<string, number>;
  sources?: Record<string, Source[]>;
  releaseWatches?: Record<string, ReleaseWatch>;
  announcedEpisodes?: string[];
}

export function trackedRemovalKey(key: string): string {
  return `tracked:${key}`;
}

export function progressRemovalKey(key: string): string {
  return `progress:${key}`;
}

export function dismissedRemovalKey(key: string): string {
  return `dismissed:${key}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTitle(value: unknown): value is TitleRef {
  return (
    isRecord(value) &&
    (value.type === "movie" || value.type === "tv") &&
    typeof value.id === "number" &&
    Number.isFinite(value.id) &&
    (value.title === undefined || typeof value.title === "string")
  );
}

export function isTrackEntry(value: unknown): boolean {
  if (!isTitle(value)) return false;
  const entry = value as unknown as Record<string, unknown>;
  const statusOk = entry.status === undefined || entry.status === null || typeof entry.status === "string";
  const ratingOk = entry.rating === undefined || entry.rating === null || typeof entry.rating === "number";
  return statusOk && ratingOk;
}

export function isProgress(item: unknown): boolean {
  return (
    isRecord(item) &&
    typeof item.position === "number" &&
    typeof item.duration === "number" &&
    Number.isFinite(item.position) &&
    Number.isFinite(item.duration) &&
    isTitle(item.title)
  );
}

export function isSourceList(item: unknown): boolean {
  return (
    Array.isArray(item) &&
    item.every((source) => isRecord(source) && typeof source.infoHash === "string" && typeof source.fileIndex === "number")
  );
}

function isReleaseWatch(item: unknown): boolean {
  return isRecord(item) && isTitle(item.title) && typeof item.topicId === "string" && typeof item.infoHash === "string";
}

export function validEntries<T>(value: unknown, valid: (item: unknown) => boolean, dropped?: { count: number }): Record<string, T> {
  if (!isRecord(value)) return {};
  const kept: Record<string, T> = {};
  for (const [key, item] of Object.entries(value)) {
    if (valid(item)) kept[key] = item as T;
    else if (dropped) dropped.count += 1;
  }
  return kept;
}

export function withNumbers(entry: TrackEntry): TrackEntry {
  const now = Date.now();
  return {
    ...entry,
    title: typeof entry.title === "string" ? entry.title : "",
    poster: typeof entry.poster === "string" ? entry.poster : null,
    backdrop: typeof entry.backdrop === "string" ? entry.backdrop : null,
    year: typeof entry.year === "string" ? entry.year : "",
    status: entry.status ?? null,
    rating: typeof entry.rating === "number" ? entry.rating : null,
    addedAt: typeof entry.addedAt === "number" ? entry.addedAt : now,
    updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : now,
  };
}

export function freshTombstones(removed: Record<string, number>, now = Date.now()): Record<string, number> {
  const kept: Record<string, number> = {};
  for (const [key, time] of Object.entries(removed)) {
    if (now - time < tombstoneLifetimeMs) kept[key] = time;
  }
  return kept;
}

export function parseAccountData(raw: unknown): { data: AccountData; dropped: number } | null {
  if (!isRecord(raw) || !isRecord(raw.tracked) || !isRecord(raw.progress)) return null;
  const dropped = { count: 0 };
  const tracked = validEntries<TrackEntry>(raw.tracked, isTrackEntry, dropped);
  for (const [key, entry] of Object.entries(tracked)) tracked[key] = withNumbers(entry);
  const progress = validEntries<Progress>(raw.progress, isProgress, dropped);
  for (const [key, item] of Object.entries(progress)) {
    progress[key] = { ...item, updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0 };
  }
  return {
    data: {
      version: typeof raw.version === "number" ? raw.version : 1,
      tracked,
      progress,
      preferences: validEntries<TitlePreferences>(raw.preferences, isRecord, dropped),
      dismissed: validEntries<Dismissal>(raw.dismissed, isTitle, dropped),
      onboardedAt: typeof raw.onboardedAt === "number" ? raw.onboardedAt : undefined,
      removed: validEntries<number>(raw.removed, (item) => typeof item === "number"),
      sources: raw.sources === undefined ? undefined : validEntries<Source[]>(raw.sources, isSourceList, dropped),
      releaseWatches: raw.releaseWatches === undefined ? undefined : validEntries<ReleaseWatch>(raw.releaseWatches, isReleaseWatch, dropped),
      announcedEpisodes: Array.isArray(raw.announcedEpisodes)
        ? raw.announcedEpisodes.filter((item): item is string => typeof item === "string")
        : undefined,
    },
    dropped: dropped.count,
  };
}

export function describeAccountData(data: AccountData): { titles: number; rated: number; episodes: number; sources: number } {
  return {
    titles: Object.keys(data.tracked).length,
    rated: Object.values(data.tracked).filter((entry) => typeof entry.rating === "number" || entry.liked).length,
    episodes: Object.keys(data.progress).length,
    sources: Object.values(data.sources ?? {}).reduce((sum, list) => sum + list.length, 0),
  };
}

function fieldTime(entry: TrackEntry, field: TrackedField): number {
  return entry.fieldsUpdatedAt?.[field] ?? entry.updatedAt ?? 0;
}

export function mergeTrackEntry(a: TrackEntry, b: TrackEntry): TrackEntry {
  const newer = b.updatedAt > a.updatedAt ? b : a;
  const merged: TrackEntry = { ...newer, fieldsUpdatedAt: { ...newer.fieldsUpdatedAt } };
  for (const field of trackedFields) {
    const winner = fieldTime(b, field) > fieldTime(a, field) ? b : a;
    (merged as unknown as Record<string, unknown>)[field] = winner[field];
    merged.fieldsUpdatedAt![field] = Math.max(fieldTime(a, field), fieldTime(b, field));
  }
  merged.addedAt = Math.min(a.addedAt || newer.addedAt, b.addedAt || newer.addedAt);
  merged.updatedAt = Math.max(a.updatedAt, b.updatedAt);
  if (merged.liked === undefined) delete merged.liked;
  if (JSON.stringify(merged) === JSON.stringify(a)) return a;
  return merged;
}

function mergeRecords<T extends { updatedAt: number }>(
  ours: Record<string, T>,
  theirs: Record<string, T>,
  removedAt: (key: string) => number,
  combine: (a: T, b: T) => T = (a, b) => (b.updatedAt > a.updatedAt ? b : a),
): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const a = ours[key];
    const b = theirs[key];
    const latest = !a ? b : !b ? a : combine(a, b);
    if (latest.updatedAt > removedAt(key)) merged[key] = latest;
  }
  return merged;
}

function mergeSources(ours: Record<string, Source[]> = {}, theirs: Record<string, Source[]> = {}): Record<string, Source[]> {
  const merged: Record<string, Source[]> = { ...ours };
  for (const [key, list] of Object.entries(theirs)) {
    const existing = merged[key] ?? [];
    const added = list.filter((source) => !existing.some((item) => item.infoHash === source.infoHash && item.fileIndex === source.fileIndex));
    if (added.length > 0) merged[key] = [...existing, ...added];
  }
  return merged;
}

function firstTime(ours: number | undefined, theirs: number | undefined): number | undefined {
  if (!ours || !theirs) return ours || theirs || undefined;
  return Math.min(ours, theirs);
}

export function mergeAccountData(ours: AccountData, theirs: AccountData): AccountData {
  const removed: Record<string, number> = { ...ours.removed };
  for (const [key, time] of Object.entries(theirs.removed)) removed[key] = Math.max(removed[key] ?? 0, time);

  return {
    version: accountDataVersion,
    tracked: mergeRecords(ours.tracked, theirs.tracked, (key) => removed[trackedRemovalKey(key)] ?? 0, mergeTrackEntry),
    progress: mergeRecords(ours.progress, theirs.progress, (key) => removed[progressRemovalKey(key)] ?? 0),
    preferences: mergeRecords(ours.preferences ?? {}, theirs.preferences ?? {}, () => 0),
    dismissed: mergeRecords(ours.dismissed ?? {}, theirs.dismissed ?? {}, (key) => removed[dismissedRemovalKey(key)] ?? 0),
    onboardedAt: firstTime(ours.onboardedAt, theirs.onboardedAt),
    removed: freshTombstones(removed),
    sources: mergeSources(ours.sources, theirs.sources),
    releaseWatches: { ...(theirs.releaseWatches ?? {}), ...(ours.releaseWatches ?? {}) },
    announcedEpisodes: [...new Set([...(ours.announcedEpisodes ?? []), ...(theirs.announcedEpisodes ?? [])])],
  };
}
