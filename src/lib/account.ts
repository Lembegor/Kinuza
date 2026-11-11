import type { Progress, TitleRef, TrackEntry } from "../state/library";

export interface TitlePreferences {
  audioLanguage?: string;
  audioTitle?: string;
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

export const accountDataVersion = 2;

export interface AccountData {
  version: number;
  tracked: Record<string, TrackEntry>;
  progress: Record<string, Progress>;
  preferences: Record<string, TitlePreferences>;
  dismissed?: Record<string, Dismissal>;
  onboardedAt?: number;
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
    if (latest.updatedAt > removedAt(key)) merged[key] = latest;
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
    tracked: newest(ours.tracked, theirs.tracked, (key) => removed[trackedRemovalKey(key)] ?? 0),
    progress: newest(ours.progress, theirs.progress, (key) => removed[progressRemovalKey(key)] ?? 0),
    preferences: newest(ours.preferences ?? {}, theirs.preferences ?? {}, () => 0),
    dismissed: newest(ours.dismissed ?? {}, theirs.dismissed ?? {}, (key) => removed[dismissedRemovalKey(key)] ?? 0),
    onboardedAt: firstTime(ours.onboardedAt, theirs.onboardedAt),
    removed,
  };
}
