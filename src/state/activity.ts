import { backend } from "../lib/backend";
import { beforeAppClose } from "../lib/lifecycle";
import type { Dismissal } from "../lib/account";
import { t } from "../lib/i18n";
import type { Progress, Source, TitleRef, TrackEntry } from "./library";
import { useProfile } from "./profile";
import { useUi } from "./ui";

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
  | "title.view"
  | "trailer"
  | "feed.open"
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
const earlierShare = 0.5;
const earlierToastDelayMs = 400;
const recentToastMs = 2000;
const pending: ActivityEvent[] = [];
const listeners = new Set<() => void>();
const pausedTypes: ReadonlySet<ActivityType> = new Set([
  "play",
  "watched",
  "unwatched",
  "title.open",
  "title.view",
  "trailer",
  "feed.open",
  "search",
  "tracker.search",
  "tracker.pick",
]);
let earlierMarks: ActivityEvent[] = [];
let earlierTimer: ReturnType<typeof setTimeout> | undefined;
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

function notifyChange(): void {
  for (const listener of listeners) listener();
}

export function onActivityChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function historyPaused(): boolean {
  return useProfile.getState().historyPaused;
}

export function recordActivity(type: ActivityType, fields: Record<string, unknown> = {}, at = Date.now()): ActivityEvent | null {
  if (pausedTypes.has(type) && historyPaused()) return null;
  const device = useProfile.getState().deviceId;
  const event: ActivityEvent = { ...fields, ...(device ? { device } : {}), id: eventId(), type, at };
  pending.push(event);
  removeCloseTask?.();
  removeCloseTask = beforeAppClose(flushActivity);
  if (flushTimer === undefined) flushTimer = setTimeout(() => void flushActivity(), flushDelayMs);
  notifyChange();
  return event;
}

export async function readActivity(since?: number): Promise<ActivityEvent[]> {
  const stored = (await backend.activityRead(since)) as ActivityEvent[];
  const known = new Set(stored.map((event) => event.id));
  const fresh = pending.filter((event) => !known.has(event.id) && (since === undefined || event.at >= since));
  return fresh.length > 0 ? [...stored, ...fresh] : stored;
}

export async function editActivity(remove: string[], upsert: ActivityEvent[]): Promise<void> {
  const gone = new Set([...remove, ...upsert.map((event) => event.id)]);
  const queued = pending.filter((event) => gone.has(event.id));
  for (const event of queued) pending.splice(pending.indexOf(event), 1);
  const queuedUpserts = upsert.filter((event) => queued.some((item) => item.id === event.id));
  pending.push(...queuedUpserts);
  const stored = upsert.filter((event) => !queuedUpserts.includes(event));
  const storedRemovals = remove.filter((id) => !queued.some((item) => item.id === id));
  if (storedRemovals.length > 0 || stored.length > 0) await backend.activityEdit(storedRemovals, stored);
  notifyChange();
}

export async function addActivity(events: ActivityEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  await flushActivity();
  const known = new Set((await readActivity()).map((event) => event.id));
  const fresh = events.filter((event) => typeof event.id === "string" && typeof event.at === "number" && typeof event.type === "string" && !known.has(event.id));
  for (let index = 0; index < fresh.length; index += 400) await backend.activityAppend(fresh.slice(index, index + 400));
  if (fresh.length > 0) notifyChange();
  return fresh.length;
}

export async function pruneActivity(before: number): Promise<number> {
  await flushActivity();
  const dropped = await backend.activityPrune(before);
  if (dropped > 0) notifyChange();
  return dropped;
}

function noteEarlierMark(event: ActivityEvent): void {
  earlierMarks.push(event);
  clearTimeout(earlierTimer);
  earlierTimer = setTimeout(() => {
    const marks = earlierMarks;
    earlierMarks = [];
    if (marks.length === 0) return;
    const name = String((marks[0].title as { name?: string } | undefined)?.name ?? "");
    const text = marks.length === 1 ? t("profile.earlier.one", { title: name }) : t("profile.earlier.many", { count: marks.length });
    const today = { label: t("profile.earlier.today"), run: () => void editActivity([], marks.map((mark) => ({ ...mark, earlier: false }))) };
    const ui = useUi.getState();
    const recent = ui.toasts.at(-1);
    if (recent?.action && recent.kind !== "error" && Date.now() - recent.at < recentToastMs) {
      ui.toast(text, recent.kind, recent.action, today);
      return;
    }
    ui.toast(text, "info", today);
  }, earlierToastDelayMs);
}

function watchedBefore(progress: Progress | undefined): number {
  if (!progress) return 0;
  return progress.played ?? progress.position;
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
        const marked = item.duration <= 1;
        const played = marked ? watchedBefore(old) : 0;
        const length = old && old.duration > 1 ? old.duration : 0;
        const earlier = marked && !(length > 0 && played >= length * earlierShare);
        const event = recordActivity(
          "watched",
          {
            unit: key,
            ...unitFields(item),
            marked,
            duration: item.duration > 1 ? Math.round(item.duration) : undefined,
            ...(marked ? { earlier, played: played > 0 ? Math.round(played) : undefined, length: length > 0 ? Math.round(length) : undefined } : {}),
          },
          at,
        );
        if (event && earlier) noteEarlierMark(event);
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
