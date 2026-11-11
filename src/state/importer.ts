// Brings ratings and lists exported from other services into the user's list: finds each row of
// the file in the catalog, then folds the result in the way another device's copy would be.

import { create } from "zustand";
import { accountDataVersion } from "../lib/account";
import { ImportError, decodeImportText, parseImportFile, type ImportProblem, type ImportRow, type ImportSource } from "../lib/importers";
import { t } from "../lib/i18n";
import { report } from "../lib/journal";
import { catalogLanguage, tmdb, type MediaItem, type MediaType } from "../lib/tmdb";
import { titleKey, toTitleRef, useLibrary, type TrackEntry, type WatchStatus } from "./library";
import { useUi } from "./ui";

/** Catalog requests in flight at once: enough to get through a long file, few enough not to be turned away. */
const parallelLookups = 4;
/** After this many lookups fail in a row the catalog is taken to be down, and the rest are not tried. */
const failuresBeforeGivingUp = 5;
/** How the catalog client reports an id the catalog does not have. */
const catalogNotFound = "tmdb_404";
/** Services disagree on the year by one when a film opened at a festival or abroad first. */
const yearTolerance = 1;
/** Shortest name for which "one name is part of the other" says anything: "It" is part of half the catalog. */
const minPartialNameLength = 4;

export interface ImportSummary {
  /** Titles the list did not have. */
  added: number;
  /** Titles already in the list whose status or rating the file changed, being the later word. */
  updated: number;
  /** Titles already in the list that stay as they are: the same there, or changed in the app later than in the file. */
  unchanged: number;
  /** Rows the catalog has nothing for, as the file names them. */
  notFound: string[];
  /** Rows that are not titles (single episodes, blank rows), repeats, and titles deleted from the list after the file's date. */
  skipped: number;
  /** Rows not looked up because the catalog stopped answering. */
  unchecked: number;
}

interface ImportState {
  phase: "idle" | "running" | "done" | "failed";
  fileName: string;
  source: ImportSource | null;
  /** Rows looked up so far, of `total`. */
  processed: number;
  total: number;
  summary: ImportSummary | null;
  /** Why the file could not be imported, in the "failed" phase. */
  problem: ImportProblem | null;
  /** Reads an export and imports it. Does nothing while another import is running. */
  start: (bytes: Uint8Array, fileName: string) => Promise<void>;
  /** Stops a running import; the list stays as it was. */
  cancel: () => void;
  /** Puts the finished import's summary away. */
  dismiss: () => void;
}

/** Letters and digits only, lower-cased, without accents: "Amélie" and "amelie" are one name. */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** The language to search in for the titles to come back worded like the name in the file, which they are compared with. */
function languageOf(name: string): string {
  if (/[іїєґ]/i.test(name)) return "uk-UA";
  return /\p{Script=Cyrillic}/u.test(name) ? "ru-RU" : "en-US";
}

/** Of several titles that fit equally, the one more people have seen is the likelier to be in someone's ratings. */
function mostVoted(items: MediaItem[]): MediaItem | null {
  return items.reduce<MediaItem | null>((best, item) => (best && best.voteCount >= item.voteCount ? best : item), null);
}

async function findByName(row: ImportRow): Promise<MediaItem | null> {
  const names = [...new Set([row.title, row.originalTitle].filter(Boolean))];
  const wanted = names.map(normalizeName);
  const types: MediaType[] = row.type ? [row.type] : ["movie", "tv"];
  const namesOf = (item: MediaItem) => [normalizeName(item.title), normalizeName(item.originalTitle)];
  const sameName = (item: MediaItem) => namesOf(item).some((name) => wanted.includes(name));
  const partOfName = (item: MediaItem) =>
    namesOf(item).some((own) =>
      wanted.some((name) => Math.min(own.length, name.length) >= minPartialNameLength && (own.includes(name) || name.includes(own))),
    );
  /** The title as the catalog words it in the interface language, whichever language it was found in. */
  const localized = (item: MediaItem, language: string) => (language === catalogLanguage() ? item : tmdb.summary(item.type, item.id));

  if (row.year !== null) {
    let closest: { item: MediaItem; language: string } | null = null;
    for (const type of types) {
      for (const name of names) {
        const language = languageOf(name);
        const found = await tmdb.searchByName(type, name, { year: row.year, language });
        const match = mostVoted(found.filter(sameName));
        if (match) return localized(match, language);
        // Services word some titles differently ("Léon" and "Léon: The Professional"). With the
        // year right, the only title found or one whose name holds the file's is taken, unless
        // another search still finds the very name.
        const near = found.length === 1 ? found[0] : mostVoted(found.filter(partOfName));
        if (near) closest ??= { item: near, language };
      }
    }
    if (closest) return localized(closest.item, closest.language);
  }

  // Without the year in the query only the very name counts, and the year may be one off.
  const language = languageOf(names[0]);
  for (const type of types) {
    const found = await tmdb.searchByName(type, names[0], { language });
    const match = mostVoted(
      found.filter((item) => sameName(item) && (row.year === null || Math.abs(Number(item.year) - row.year) <= yearTolerance)),
    );
    if (match) return localized(match, language);
  }
  return null;
}

/** The catalog's title for a row of the file; null when it has none. Rejects when the catalog cannot be asked. */
async function lookUp(row: ImportRow): Promise<MediaItem | null> {
  if (row.tmdbId !== null && row.type) {
    try {
      return await tmdb.summary(row.type, row.tmdbId);
    } catch (error) {
      const gone = error instanceof Error && error.message === catalogNotFound;
      if (!gone) throw error;
    }
  }
  if (row.imdbId) {
    const found = await tmdb.findByImdbId(row.imdbId);
    const match = found.find((item) => item.type === row.type) ?? found[0];
    if (match) return match;
  }
  return row.title || row.originalTitle ? findByName(row) : null;
}

/** How a row that was not found is shown to the user. */
function rowLabel(row: ImportRow): string {
  const name = row.title || row.originalTitle || row.imdbId || String(row.tmdbId ?? "");
  return row.year === null ? name : t("import.notFound.item", { title: name, year: row.year });
}

/** What the file says about one catalog title, all its rows taken together. */
interface Finding {
  item: MediaItem;
  planned: boolean;
  rating: number | null;
  /** The latest date among the rows; null when none has one. */
  date: number | null;
}

/** Two rows about the same title: seen outweighs planned, the later rating and the later date stay. */
function combine(earlier: Finding, row: ImportRow): Finding {
  const rowIsLater = (row.date ?? -Infinity) > (earlier.date ?? -Infinity);
  const rating = row.rating !== null && (earlier.rating === null || rowIsLater) ? row.rating : earlier.rating;
  const date = earlier.date === null ? row.date : row.date === null ? earlier.date : Math.max(earlier.date, row.date);
  return { item: earlier.item, planned: earlier.planned && row.mark === "planned", rating, date };
}

/**
 * The entry a finding would put in the list, or null when it would change nothing. The entry is
 * dated as the file says, so that merging lets a later change made in the app stand. A row without
 * a date cannot be compared that way: it adds a title, but never touches one already in the list.
 */
function toEntry(finding: Finding, existing: TrackEntry | undefined, now: number): TrackEntry | null {
  // A date in the future (a wrong clock somewhere) would outrank everything the user does until then.
  const time = finding.date !== null ? Math.min(finding.date, now) : existing ? null : now;
  const status: WatchStatus = finding.planned ? "planned" : "completed";
  const rating = finding.rating ?? existing?.rating ?? null;
  if (time === null || (existing && existing.status === status && existing.rating === rating)) return null;
  return {
    ...existing,
    ...toTitleRef(finding.item),
    status,
    rating,
    addedAt: Math.min(existing?.addedAt ?? time, time),
    updatedAt: time,
  };
}

/** Folds what was found into the list and counts what that changed. */
function applyFindings(rows: ImportRow[], found: (MediaItem | null | undefined)[], skippedInFile: number): ImportSummary {
  const summary: ImportSummary = { added: 0, updated: 0, unchanged: 0, notFound: [], skipped: skippedInFile, unchecked: 0 };
  const findings = new Map<string, Finding>();

  rows.forEach((row, index) => {
    const item = found[index];
    if (item === undefined) summary.unchecked++;
    else if (item === null) summary.notFound.push(rowLabel(row));
    else {
      const key = titleKey(item.type, item.id);
      const earlier = findings.get(key);
      if (earlier) summary.skipped++;
      findings.set(key, earlier ? combine(earlier, row) : { item, planned: row.mark === "planned", rating: row.rating, date: row.date });
    }
  });

  const before = useLibrary.getState().tracked;
  const now = Date.now();
  const entries: Record<string, TrackEntry> = {};
  for (const [key, finding] of findings) {
    const entry = toEntry(finding, before[key], now);
    if (entry) entries[key] = entry;
    else summary.unchanged++;
  }

  useLibrary.getState().mergeAccountData({ version: accountDataVersion, tracked: entries, progress: {}, preferences: {}, removed: {} });

  const after = useLibrary.getState().tracked;
  for (const key of Object.keys(entries)) {
    if (!after[key]) summary.skipped++; // Deleted from the list later than the file's date: the deletion stands.
    else if (!before[key]) summary.added++;
    else if (after[key] !== before[key]) summary.updated++;
    else summary.unchanged++;
  }
  return summary;
}

/** Counts started imports; a run whose number is no longer the current one was cancelled. */
let currentRun = 0;

export const useImport = create<ImportState>((set, get) => ({
  phase: "idle",
  fileName: "",
  source: null,
  processed: 0,
  total: 0,
  summary: null,
  problem: null,

  async start(bytes, fileName) {
    if (get().phase === "running") return;
    const run = ++currentRun;

    let parsed;
    try {
      parsed = parseImportFile(decodeImportText(bytes), fileName);
    } catch (error) {
      const problem = error instanceof ImportError ? error.problem : "malformed";
      set({ phase: "failed", fileName, source: null, summary: null, problem });
      return;
    }

    const { rows } = parsed;
    set({ phase: "running", fileName, source: parsed.source, processed: 0, total: rows.length, summary: null, problem: null });

    /** By row: the title found, null when the catalog has none, undefined while not looked up. */
    const found: (MediaItem | null | undefined)[] = new Array(rows.length).fill(undefined);
    let next = 0;
    let failuresInRow = 0;
    let lastFailure: unknown = null;
    const active = () => run === currentRun && failuresInRow < failuresBeforeGivingUp;

    const worker = async () => {
      while (active() && next < rows.length) {
        const index = next++;
        try {
          found[index] = await lookUp(rows[index]);
          failuresInRow = 0;
        } catch (error) {
          failuresInRow++;
          lastFailure = error;
        }
        if (run === currentRun) set((state) => ({ processed: state.processed + 1 }));
      }
    };
    await Promise.all(Array.from({ length: parallelLookups }, worker));
    if (run !== currentRun) return;

    if (failuresInRow >= failuresBeforeGivingUp) report("import", "journal.import.stopped", lastFailure);
    set({ phase: "done", summary: applyFindings(rows, found, parsed.skipped) });
  },

  cancel() {
    if (get().phase !== "running") return;
    currentRun++;
    set({ phase: "idle" });
    useUi.getState().toast(t("import.cancelled"), "info");
  },

  dismiss() {
    if (get().phase !== "running") set({ phase: "idle", summary: null, problem: null });
  },
}));
