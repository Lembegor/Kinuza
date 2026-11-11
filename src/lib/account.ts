// The part of the user's data that belongs to them rather than to this computer, and how two
// copies of it are combined. Today there is one copy, in a local file; with an account the same
// merge reconciles this device with the server. Pure: no network and no storage.

import type { Progress, TitleRef, TrackEntry } from "../state/library";

/**
 * How the user watches one particular title: the voice-over and subtitles they picked for it,
 * the speed, and timing corrections. Kept per title, so one series does not change another.
 */
export interface TitlePreferences {
  /** Two-letter code of the chosen voice-over language. */
  audioLanguage?: string;
  /** The chosen voice-over as the release names its track ("HDrezka (DUB)"), to pick the same studio in the next episode. */
  audioTitle?: string;
  /** Two-letter code of the chosen subtitle language, or "off". */
  subtitleLanguage?: string;
  /** Playback speed; 1 is normal. */
  rate?: number;
  /** Seconds the subtitles are shown later (negative: earlier) than the file says. */
  subtitleDelay?: number;
  /** Seconds the sound is played later (negative: earlier) than the file says. */
  audioDelay?: number;
  updatedAt: number;
}

/**
 * A recommendation the user waved away ("not interested"). The title's card data is kept so the
 * list of dismissed titles can be shown without asking the catalog.
 */
export interface Dismissal extends TitleRef {
  updatedAt: number;
}

/** Bumped when the shape below changes, so an older client or server can tell. */
export const accountDataVersion = 2;

/**
 * Statuses, ratings and watch progress, keyed by catalog ids that mean the same on any device.
 * Torrents attached to titles are left out on purpose: they describe files on one computer.
 */
export interface AccountData {
  version: number;
  /** Tracked titles by `type:id`. */
  tracked: Record<string, TrackEntry>;
  /** Watch progress by unit key (`movie:id` or `tv:id:season:episode`). */
  progress: Record<string, Progress>;
  /** Viewing preferences by `type:id`. */
  preferences: Record<string, TitlePreferences>;
  /** Recommendations the user dismissed, by `type:id`. Absent in copies written before dismissals existed. */
  dismissed?: Record<string, Dismissal>;
  /** When the first-run introduction was finished or skipped; absent until then, so it is offered once per user, not once per device. */
  onboardedAt?: number;
  /**
   * When something was deleted, by `tracked:<key>`, `progress:<key>` or `dismissed:<key>`. Without
   * these a deletion on one device would be undone by the copy that still has the record.
   */
  removed: Record<string, number>;
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

function newest<T extends { updatedAt: number }>(
  ours: Record<string, T>,
  theirs: Record<string, T>,
  removedAt: (key: string) => number,
): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const a = ours[key];
    const b = theirs[key];
    const latest = !a ? b : !b ? a : b.updatedAt > a.updatedAt ? b : a;
    // A record changed after its deletion was brought back on purpose and stays.
    if (latest.updatedAt > removedAt(key)) merged[key] = latest;
  }
  return merged;
}

/** The earlier of two moments something happened for the first time; undefined when it has not happened in either copy. */
function firstTime(ours: number | undefined, theirs: number | undefined): number | undefined {
  if (!ours || !theirs) return ours || theirs || undefined;
  return Math.min(ours, theirs);
}

/**
 * Combines two copies of a user's data: for every record the later change wins, and a deletion
 * counts as a change. The result does not depend on which copy is passed first.
 */
export function mergeAccountData(ours: AccountData, theirs: AccountData): AccountData {
  const removed: Record<string, number> = { ...ours.removed };
  for (const [key, time] of Object.entries(theirs.removed)) removed[key] = Math.max(removed[key] ?? 0, time);

  return {
    version: accountDataVersion,
    tracked: newest(ours.tracked, theirs.tracked, (key) => removed[trackedRemovalKey(key)] ?? 0),
    progress: newest(ours.progress, theirs.progress, (key) => removed[progressRemovalKey(key)] ?? 0),
    // Copies written before preferences existed have none.
    preferences: newest(ours.preferences ?? {}, theirs.preferences ?? {}, () => 0),
    dismissed: newest(ours.dismissed ?? {}, theirs.dismissed ?? {}, (key) => removed[dismissedRemovalKey(key)] ?? 0),
    onboardedAt: firstTime(ours.onboardedAt, theirs.onboardedAt),
    removed,
  };
}
