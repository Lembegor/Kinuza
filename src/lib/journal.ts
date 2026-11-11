// A journal of recent problems: what went wrong in the background, where the user would otherwise
// only notice that something does not work. Kept in memory and on disk, so it survives a restart.

import { create } from "zustand";
import { backend } from "./backend";
import type { MessageKey } from "./i18n";

const storeName = "journal";
/** The oldest entries beyond this are dropped: the journal is for what happened lately. */
const maxEntries = 200;
const saveDelayMs = 500;
/** Longest technical detail kept with an entry; some errors carry a whole page of text. */
const maxDetailLength = 300;

/** The part of the app a problem belongs to. */
export type JournalArea = "catalog" | "downloads" | "player" | "import" | "settings" | "updates" | "system";

export interface JournalEntry {
  /** When the problem happened last, in milliseconds. */
  time: number;
  area: JournalArea;
  /** Names the message that says, in plain words, what did not work. */
  message: MessageKey;
  /** The error as the program reported it: a code or a message. Empty when there is none. */
  detail: string;
  /** How many times in a row the same problem happened. */
  count: number;
}

interface JournalState {
  /** Oldest first. */
  entries: JournalEntry[];
}

export const useJournal = create<JournalState>(() => ({ entries: [] }));

function detailText(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  const text = typeof detail === "string" ? detail : detail instanceof Error ? detail.message : JSON.stringify(detail);
  return (text ?? "").slice(0, maxDetailLength);
}

function isEntry(value: unknown): value is JournalEntry {
  const entry = value as Partial<JournalEntry> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.time === "number" &&
    typeof entry.area === "string" &&
    typeof entry.message === "string" &&
    typeof entry.detail === "string" &&
    typeof entry.count === "number"
  );
}

let loading: Promise<void> | null = null;

/** Reads what earlier sessions recorded; problems reported in the meantime stay after it. */
export function loadJournal(): Promise<void> {
  loading ??= backend
    .storeGet(storeName)
    .then((text) => {
      const stored: unknown = text ? JSON.parse(text) : [];
      const earlier = Array.isArray(stored) ? stored.filter(isEntry) : [];
      useJournal.setState((state) => ({ entries: [...earlier, ...state.entries].slice(-maxEntries) }));
    })
    // A journal that cannot be read starts empty; reporting that here would only go round in a circle.
    .catch((error) => console.error("journal: load failed", error));
  return loading;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Saving before the stored entries are read would replace them with this session's alone.
    void loadJournal()
      .then(() => backend.storeSet(storeName, JSON.stringify(useJournal.getState().entries)))
      .catch((error) => console.error("journal: save failed", error));
  }, saveDelayMs);
}

/**
 * Records a problem for the "What happened" page. `message` is what the user reads; `detail` is
 * the caught error, kept for whoever looks into it. A problem that repeats without anything else
 * happening in between (a poll failing every second) is counted on one entry instead of filling
 * the journal.
 */
export function report(area: JournalArea, message: MessageKey, detail?: unknown): void {
  console.error(`${area}: ${message}`, detail ?? "");
  const text = detailText(detail);
  const time = Date.now();
  useJournal.setState((state) => {
    const last = state.entries.at(-1);
    const repeated = last !== undefined && last.area === area && last.message === message && last.detail === text;
    const entries = repeated
      ? [...state.entries.slice(0, -1), { ...last, time, count: last.count + 1 }]
      : [...state.entries, { time, area, message, detail: text, count: 1 }];
    return { entries: entries.slice(-maxEntries) };
  });
  scheduleSave();
}

export function clearJournal(): void {
  useJournal.setState({ entries: [] });
  scheduleSave();
}
