import { useCallback, useEffect, useRef } from "react";
import { backend, isDesktop } from "../lib/backend";
import { pickInitialSource, sortSources } from "../lib/sources";
import { isWatched, useLibrary, type Progress, type Source } from "./library";
import { useSettings } from "./settings";
import { fileProgress, useTorrents } from "./torrents";

const hoverDelayMs = 300;
const repeatLightMs = 90_000;
const repeatFullMs = 4 * 60_000;
const recentDays = 3;
const dayMs = 86_400_000;
const titleRecentDays = 30;

const lastWarmed = new Map<string, { at: number; full: boolean }>();

function warmSource(source: Source, full: boolean): void {
  if (!isDesktop) return;
  if (fileProgress(useTorrents.getState().byHash[source.infoHash], source.fileIndex) >= 1) return;
  const key = `${source.infoHash}:${source.fileIndex}`;
  const now = Date.now();
  const previous = lastWarmed.get(key);
  if (previous && (previous.full || !full) && now - previous.at < (previous.full ? repeatFullMs : repeatLightMs)) return;
  lastWarmed.set(key, { at: now, full });
  void backend.warm(source.infoHash, source.fileIndex, full).catch(() => undefined);
}

export function sourceToPlay(unitKey: string, preferredSourceId?: string): Source | undefined {
  const sources = sortSources(useLibrary.getState().sources[unitKey] ?? []);
  return pickInitialSource(sources, preferredSourceId, useSettings.getState().preferredQuality);
}

export function warmUnit(unitKey: string, full: boolean, preferredSourceId?: string): void {
  const source = sourceToPlay(unitKey, preferredSourceId);
  if (source) warmSource(source, full);
}

export function warmFile(infoHash: string, fileIndex: number, full: boolean): void {
  if (!isDesktop) return;
  const key = `${infoHash}:${fileIndex}`;
  const previous = lastWarmed.get(key);
  if (previous && (previous.full || !full) && Date.now() - previous.at < repeatLightMs) return;
  lastWarmed.set(key, { at: Date.now(), full });
  void backend.warm(infoHash, fileIndex, full).catch(() => undefined);
}

export function useHoverWarm(unitKey: string | null, preferredSourceId?: string) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const start = useCallback(() => {
    if (!unitKey) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => warmUnit(unitKey, true, preferredSourceId), hoverDelayMs);
  }, [unitKey, preferredSourceId]);
  const stop = useCallback(() => clearTimeout(timer.current), []);
  return { onPointerEnter: start, onPointerLeave: stop, onFocus: start, onBlur: stop };
}

function nextUnitKey(progress: Progress): string | null {
  if (progress.title.type !== "tv" || progress.season === undefined || progress.episode === undefined) return null;
  const { sources } = useLibrary.getState();
  const prefix = `tv:${progress.title.id}:`;
  const candidates = Object.keys(sources)
    .filter((key) => key.startsWith(prefix))
    .map((key) => {
      const [, , season, episode] = key.split(":");
      return { key, season: Number(season), episode: Number(episode) };
    })
    .filter(({ season, episode }) => season > 0 && (season > progress.season! || (season === progress.season && episode > progress.episode!)))
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  return candidates[0]?.key ?? null;
}

export function resumeUnitOf(unitKey: string, progress: Progress): string | null {
  return isWatched(progress) ? nextUnitKey(progress) : unitKey;
}

export function warmRecentResume(): void {
  const { progress } = useLibrary.getState();
  const since = Date.now() - recentDays * dayMs;
  const latest = Object.entries(progress)
    .filter(([, item]) => item.updatedAt >= since)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)[0];
  if (!latest) return;
  const unit = resumeUnitOf(latest[0], latest[1]);
  if (unit) warmUnit(unit, false);
}

export function warmTitleResume(type: string, id: number): void {
  const { progress } = useLibrary.getState();
  const prefix = type === "tv" ? `tv:${id}:` : `movie:${id}`;
  const latest = Object.entries(progress)
    .filter(([key]) => (type === "tv" ? key.startsWith(prefix) : key === prefix))
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)[0];
  if (!latest || latest[1].updatedAt < Date.now() - titleRecentDays * dayMs) return;
  const unit = resumeUnitOf(latest[0], latest[1]);
  if (unit) warmUnit(unit, false);
}
