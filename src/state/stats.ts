import { useEffect, useMemo, useState } from "react";
import { catalogRecord } from "../lib/catalog";
import { archiveBefore, buildLedger, type Ledger, type TitleInfo } from "../lib/profileStats";
import { tmdb } from "../lib/tmdb";
import { onActivityChange, pruneActivity, readActivity, type ActivityEvent } from "./activity";
import { titleKey, useLibrary } from "./library";
import { useProfile, type HistoryRetention, type MonthTotals } from "./profile";

const animationGenreId = 16;
const runtimeBatch = 8;
const runtimeLimitPerRun = 400;
const retentionMonths: Record<Exclude<HistoryRetention, "forever">, number> = { year: 12, quarter: 3 };

const infoCache = new Map<string, TitleInfo | null>();
const runtimeTried = new Set<string>();
let runtimeRun: Promise<void> | null = null;

function keyOfUnit(unit: string): string {
  const parts = unit.split(":");
  return `${parts[0]}:${parts[1]}`;
}

async function loadInfo(keys: string[]): Promise<boolean> {
  const missing = keys.filter((key) => !infoCache.has(key));
  if (missing.length === 0) return false;
  await Promise.all(
    missing.map(async (key) => {
      const [type, id] = key.split(":");
      try {
        const record = await catalogRecord(type === "movie" ? "movie" : "tv", Number(id));
        infoCache.set(
          key,
          record
            ? {
                anime: (record.g ?? []).includes(animationGenreId) && record.l === "ja",
                genres: record.g ?? [],
                language: record.l ?? "",
                vote: record.c > 0 ? record.v : 0,
                year: record.y ?? 0,
              }
            : null,
        );
      } catch {
        infoCache.set(key, null);
      }
    }),
  );
  return true;
}

function infoMap(): Map<string, TitleInfo> {
  const map = new Map<string, TitleInfo>();
  for (const [key, value] of infoCache) if (value) map.set(key, value);
  return map;
}

export function fillRuntimes(): Promise<void> {
  runtimeRun ??= (async () => {
    const { tracked, progress } = useLibrary.getState();
    const watchedKeys = new Set(Object.keys(progress).map(keyOfUnit));
    const wanted = Object.entries(tracked)
      .filter(([key, entry]) => !entry.runtime && !runtimeTried.has(key) && (entry.status === "completed" || entry.status === "planned" || watchedKeys.has(key) || entry.rewatches))
      .map(([key]) => key)
      .slice(0, runtimeLimitPerRun);
    for (let index = 0; index < wanted.length; index += runtimeBatch) {
      const found: Record<string, number> = {};
      await Promise.all(
        wanted.slice(index, index + runtimeBatch).map(async (key) => {
          const [type, id] = key.split(":");
          runtimeTried.add(key);
          try {
            const details = await tmdb.details(type === "movie" ? "movie" : "tv", Number(id));
            if (details.runtimeMinutes) found[key] = details.runtimeMinutes;
          } catch {
            return;
          }
        }),
      );
      useLibrary.getState().noteRuntimes(found);
    }
  })().finally(() => {
    runtimeRun = null;
  });
  return runtimeRun;
}

export function useActivityEvents(): { events: ActivityEvent[]; loaded: boolean } {
  const [state, setState] = useState<{ events: ActivityEvent[]; loaded: boolean }>({ events: [], loaded: false });
  useEffect(() => {
    let alive = true;
    const load = () =>
      void readActivity()
        .then((events) => {
          if (!alive) return;
          setState({ events, loaded: true });
          const profile = useProfile.getState();
          if (profile.loaded && profile.journalSince === null) {
            profile.noteJournalSince(events.length > 0 ? Math.min(...events.map((event) => event.at)) : Date.now());
          }
        })
        .catch(() => alive && setState((previous) => ({ ...previous, loaded: true })));
    load();
    const stop = onActivityChange(load);
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return state;
}

function ledgerKeys(tracked: object, progress: object, events: ActivityEvent[]): string[] {
  const set = new Set<string>(Object.keys(tracked));
  for (const unit of Object.keys(progress)) set.add(keyOfUnit(unit));
  for (const event of events) {
    const title = event.title as { type?: string; id?: number } | undefined;
    if (title && typeof title.id === "number" && (title.type === "movie" || title.type === "tv")) set.add(titleKey(title.type, title.id));
  }
  return [...set];
}

export async function buildLedgerNow(): Promise<Ledger | null> {
  const library = useLibrary.getState();
  const profile = useProfile.getState();
  if (!library.loaded || !profile.loaded) return null;
  const events = await readActivity();
  await loadInfo(ledgerKeys(library.tracked, library.progress, events));
  return buildLedger({
    tracked: library.tracked,
    progress: library.progress,
    preferences: library.preferences,
    events,
    info: infoMap(),
    hidden: profile.hidden,
    archive: profile.archive,
    journalSince: profile.journalSince,
  });
}

export function useLedger(): { ledger: Ledger | null; events: ActivityEvent[] } {
  const { events, loaded } = useActivityEvents();
  const tracked = useLibrary((state) => state.tracked);
  const progress = useLibrary((state) => state.progress);
  const preferences = useLibrary((state) => state.preferences);
  const libraryLoaded = useLibrary((state) => state.loaded);
  const hidden = useProfile((state) => state.hidden);
  const archive = useProfile((state) => state.archive);
  const journalSince = useProfile((state) => state.journalSince);
  const profileLoaded = useProfile((state) => state.loaded);
  const [infoVersion, setInfoVersion] = useState(0);

  const keys = useMemo(() => ledgerKeys(tracked, progress, events), [tracked, progress, events]);

  useEffect(() => {
    let alive = true;
    void loadInfo(keys).then((changed) => {
      if (alive && changed) setInfoVersion((value) => value + 1);
    });
    return () => {
      alive = false;
    };
  }, [keys]);

  const ledger = useMemo(() => {
    if (!loaded || !libraryLoaded || !profileLoaded) return null;
    return buildLedger({ tracked, progress, preferences, events, info: infoMap(), hidden, archive, journalSince });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, libraryLoaded, profileLoaded, tracked, progress, preferences, events, hidden, archive, journalSince, infoVersion]);

  return { ledger, events };
}

function addTotals(target: Record<string, MonthTotals>, extra: Record<string, MonthTotals>): Record<string, MonthTotals> {
  const result = { ...target };
  for (const [month, totals] of Object.entries(extra)) {
    const known = result[month] ?? { movie: 0, tv: 0, anime: 0 };
    result[month] = { movie: known.movie + totals.movie, tv: known.tv + totals.tv, anime: known.anime + totals.anime };
  }
  return result;
}

export async function applyRetention(now = Date.now()): Promise<void> {
  const profile = useProfile.getState();
  const library = useLibrary.getState();
  if (!profile.loaded || !library.loaded || profile.retention === "forever") return;
  const today = new Date(now);
  const cutoff = new Date(today.getFullYear(), today.getMonth() - retentionMonths[profile.retention], 1).getTime();
  const events = await readActivity();
  const old = events.filter((event) => event.at < cutoff);
  if (old.length === 0) return;
  const keys = [...new Set(old.map((event) => (typeof event.unit === "string" ? keyOfUnit(event.unit) : "")).filter(Boolean))];
  await loadInfo(keys);
  const ledger = buildLedger({
    tracked: library.tracked,
    progress: library.progress,
    preferences: library.preferences,
    events,
    info: infoMap(),
    hidden: profile.hidden,
    archive: {},
    journalSince: profile.journalSince,
  });
  profile.patch({ archive: addTotals(profile.archive, archiveBefore(ledger, cutoff)) });
  await pruneActivity(cutoff);
}
