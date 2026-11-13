import { backend } from "../lib/backend";
import { beforeAppClose } from "../lib/lifecycle";
import type { Dismissal } from "../lib/account";
import type { Progress, Source, TitleRef, TrackEntry } from "./library";

export type ActivityType =
  | "list.add"
  | "list.remove"
  | "status"
  | "rating"
  | "like"
  | "watched"
  | "unwatched"
  | "play"
  | "dismiss"
  | "dismiss.undo"
  | "source.add"
  | "source.remove"
  | "release.follow"
  | "release.forget"
  | "onboarding"
  | "title.open"
  | "search"
  | "tracker.search"
  | "tracker.pick";

export interface ActivityEvent {
  id: string;
  type: ActivityType;
  at: number;
  [field: string]: unknown;
}

interface Snapshot {
  tracked: Record<string, TrackEntry>;
  progress: Record<string, Progress>;
  dismissed: Record<string, Dismissal>;
  sources: Record<string, Source[]>;
  releaseWatches: Record<string, { title: TitleRef }>;
  onboardedAt?: number;
}

const flushDelayMs = 4000;
const pending: ActivityEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | null = null;
let removeCloseTask: (() => void) | null = null;

function eventId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function titleOf(title: Pick<TitleRef, "type" | "id" | "title" | "year">): Record<string, unknown> {
  return { type: title.type, id: title.id, name: title.title, year: title.year };
}

function unitFields(progress: Progress): Record<string, unknown> {
  return {
    title: titleOf(progress.title),
    ...(progress.season !== undefined ? { season: progress.season } : {}),
    ...(progress.episode !== undefined ? { episode: progress.episode } : {}),
  };
}

async function flush(): Promise<void> {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (pending.length === 0) return;
  const batch = pending.splice(0, pending.length);
  try {
    await backend.activityAppend(batch);
  } catch {
    pending.unshift(...batch);
  }
}

export function flushActivity(): Promise<void> {
  flushing ??= flush().finally(() => {
    flushing = null;
  });
  return flushing;
}

export function recordActivity(type: ActivityType, fields: Record<string, unknown> = {}, at = Date.now()): void {
  pending.push({ ...fields, id: eventId(), type, at });
  removeCloseTask?.();
  removeCloseTask = beforeAppClose(flushActivity);
  if (flushTimer === undefined) flushTimer = setTimeout(() => void flushActivity(), flushDelayMs);
}

export function readActivity(since?: number): Promise<ActivityEvent[]> {
  return backend.activityRead(since) as Promise<ActivityEvent[]>;
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushActivity();
  });
}

export function noteLibraryChange(before: Snapshot, after: Snapshot, watched: (progress: Progress | undefined) => boolean): void {
  const at = Date.now();
  if (after.tracked !== before.tracked) {
    for (const [key, entry] of Object.entries(after.tracked)) {
      const old = before.tracked[key];
      if (old === entry) continue;
      const title = titleOf(entry);
      if (!old) {
        recordActivity("list.add", { title, status: entry.status, rating: entry.rating, ...(entry.liked ? { liked: true } : {}) }, at);
        continue;
      }
      if (old.status !== entry.status) recordActivity("status", { title, from: old.status, to: entry.status }, at);
      if (old.rating !== entry.rating) recordActivity("rating", { title, from: old.rating, to: entry.rating }, at);
      if (Boolean(old.liked) !== Boolean(entry.liked)) recordActivity("like", { title, liked: Boolean(entry.liked) }, at);
    }
    for (const [key, entry] of Object.entries(before.tracked)) {
      if (!after.tracked[key]) recordActivity("list.remove", { title: titleOf(entry), status: entry.status, rating: entry.rating }, at);
    }
  }
  if (after.progress !== before.progress) {
    for (const [key, item] of Object.entries(after.progress)) {
      const old = before.progress[key];
      if (old === item) continue;
      const now = watched(item);
      if (now && !watched(old)) {
        recordActivity("watched", { unit: key, ...unitFields(item), marked: item.duration <= 1, duration: item.duration > 1 ? Math.round(item.duration) : undefined }, at);
      } else if (!now && old && watched(old)) {
        recordActivity("unwatched", { unit: key, ...unitFields(item) }, at);
      }
    }
    for (const [key, item] of Object.entries(before.progress)) {
      if (!after.progress[key] && watched(item)) recordActivity("unwatched", { unit: key, ...unitFields(item) }, at);
    }
  }
  if (after.dismissed !== before.dismissed) {
    for (const [key, item] of Object.entries(after.dismissed)) {
      if (!before.dismissed[key]) recordActivity("dismiss", { title: titleOf(item), reason: item.reason, personId: item.personId }, at);
    }
    for (const [key, item] of Object.entries(before.dismissed)) {
      if (!after.dismissed[key]) recordActivity("dismiss.undo", { title: titleOf(item) }, at);
    }
  }
  if (after.sources !== before.sources) {
    for (const [key, list] of Object.entries(after.sources)) {
      if (before.sources[key] === list) continue;
      const known = new Set((before.sources[key] ?? []).map((source) => source.id));
      for (const source of list) {
        if (!known.has(source.id)) {
          recordActivity("source.add", { unit: key, quality: source.quality, size: source.size, torrent: source.torrentName, tags: source.tags }, at);
        }
      }
    }
    for (const [key, list] of Object.entries(before.sources)) {
      const kept = new Set((after.sources[key] ?? []).map((source) => source.id));
      for (const source of list) {
        if (!kept.has(source.id)) recordActivity("source.remove", { unit: key, quality: source.quality, size: source.size }, at);
      }
    }
  }
  if (after.releaseWatches !== before.releaseWatches) {
    for (const [key, item] of Object.entries(after.releaseWatches)) {
      if (!before.releaseWatches[key]) recordActivity("release.follow", { title: titleOf(item.title) }, at);
    }
    for (const [key, item] of Object.entries(before.releaseWatches)) {
      if (!after.releaseWatches[key]) recordActivity("release.forget", { title: titleOf(item.title) }, at);
    }
  }
  if (after.onboardedAt && !before.onboardedAt) recordActivity("onboarding", {}, at);
}
