import { useMemo } from "react";
import { dayToDate, localDay, recentDays, shiftDay } from "./calendar";
import { isWatched, titleKey, useLibrary, type Progress, type TitleRef, type TrackEntry } from "./library";
import { useSettings } from "./settings";
import { fileProgress, useTorrents } from "./torrents";
import { useUi } from "./ui";
import { useUpNext, type UpNextEpisode } from "./upNext";

const msPerDay = 86_400_000;
const minResumeSeconds = 30;
const staleDays = 60;
const continueLimit = 12;
const doneShare = 0.999;

export type ContinueKind = "resume" | "new" | "next";

export interface ContinueItem {
  kind: ContinueKind;
  unitKey: string;
  title: TitleRef;
  season?: number;
  episode?: number;
  episodeName?: string;
  still: string | null;
  progress?: Progress;
  airDate?: string;
  sortAt: number;
  eventAt: number;
}

function dayStart(day: string): number {
  return dayToDate(day).getTime();
}

function resumeItems(progress: Record<string, Progress>, tracked: Record<string, TrackEntry>, playing: string | undefined, now: number): ContinueItem[] {
  const latest = new Map<string, [string, Progress]>();
  for (const entry of Object.entries(progress).sort(([, a], [, b]) => b.updatedAt - a.updatedAt)) {
    const show = titleKey(entry[1].title.type, entry[1].title.id);
    if (!latest.has(show)) latest.set(show, entry);
  }
  return [...latest.values()]
    .filter(([key, item]) => {
      if (isWatched(item)) return false;
      if (tracked[titleKey(item.title.type, item.title.id)]?.status === "dropped") return false;
      if (key !== playing && now - item.updatedAt > staleDays * msPerDay) return false;
      return item.title.type === "tv" ? item.position >= 1 : item.position >= minResumeSeconds || key === playing;
    })
    .map(([key, item]) => ({
      kind: "resume" as const,
      unitKey: key,
      title: item.title,
      season: item.season,
      episode: item.episode,
      episodeName: item.episodeName,
      still: null,
      progress: item,
      sortAt: item.updatedAt,
      eventAt: item.updatedAt,
    }));
}

function upNextItem(item: UpNextEpisode, today: string, now: number): ContinueItem | null {
  const aired = item.airDate ? dayStart(item.airDate) : 0;
  const fresh = item.airDate !== "" && item.airDate >= shiftDay(today, -recentDays);
  if (!fresh && now - item.lastActivity > staleDays * msPerDay) return null;
  return {
    kind: fresh ? "new" : "next",
    unitKey: item.unitKey,
    title: item.title,
    season: item.season,
    episode: item.episode,
    episodeName: item.name,
    still: item.still,
    airDate: item.airDate,
    sortAt: fresh ? Math.max(item.lastActivity, aired + msPerDay) : item.lastActivity,
    eventAt: fresh ? Math.max(item.lastActivity, aired) : item.lastActivity,
  };
}

export function mergeContinue(resume: ContinueItem[], upNext: ContinueItem[]): ContinueItem[] {
  const shows = new Set(resume.map((item) => titleKey(item.title.type, item.title.id)));
  const extra = upNext.filter((item) => !shows.has(titleKey(item.title.type, item.title.id)));
  return [...resume, ...extra].sort((a, b) => b.sortAt - a.sortAt).slice(0, continueLimit);
}

export function useContinueItems(): ContinueItem[] {
  const progress = useLibrary((state) => state.progress);
  const tracked = useLibrary((state) => state.tracked);
  const playing = useUi((state) => state.player?.unitKey);
  const upNext = useUpNext();
  const hidden = useSettings((state) => state.continueHidden);
  return useMemo(() => {
    const now = Date.now();
    const today = localDay(new Date(now));
    const visible = (item: ContinueItem) => (hidden[titleKey(item.title.type, item.title.id)] ?? 0) < item.eventAt || item.unitKey === playing;
    const resume = resumeItems(progress, tracked, playing, now).filter(visible);
    const next = (upNext ?? []).flatMap((item) => upNextItem(item, today, now) ?? []).filter(visible);
    return mergeContinue(resume, next);
  }, [progress, tracked, playing, upNext, hidden]);
}

export function useIsDownloaded(unitKey: string): boolean {
  const sources = useLibrary((state) => state.sources[unitKey]);
  return useTorrents((state) => (sources ?? []).some((source) => fileProgress(state.byHash[source.infoHash], source.fileIndex) >= doneShare));
}

export function daysSince(day: string, today: string): number {
  return Math.round((dayStart(today) - dayStart(day)) / msPerDay);
}

export function hideFromContinue(title: TitleRef): () => void {
  const showKey = titleKey(title.type, title.id);
  const { continueHidden, patch } = useSettings.getState();
  const before = continueHidden[showKey];
  patch({ continueHidden: { ...continueHidden, [showKey]: Date.now() } });
  return () => {
    const current = { ...useSettings.getState().continueHidden };
    if (before === undefined) delete current[showKey];
    else current[showKey] = before;
    useSettings.getState().patch({ continueHidden: current });
  };
}
