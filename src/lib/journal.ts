import { create } from "zustand";
import { backend } from "./backend";
import type { MessageKey } from "./i18n";

const storeName = "journal";
const maxEntries = 200;
const saveDelayMs = 500;
const maxDetailLength = 300;

export type JournalArea = "catalog" | "library" | "downloads" | "player" | "import" | "settings" | "updates" | "system";

export interface JournalEntry {
  time: number;
  area: JournalArea;
  message: MessageKey;
  detail: string;
  count: number;
}

interface JournalState {
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

export function loadJournal(): Promise<void> {
  loading ??= backend
    .storeGet(storeName)
    .then((document) => {
      const stored: unknown = document ? JSON.parse(document.text) : [];
      const earlier = Array.isArray(stored) ? stored.filter(isEntry) : [];
      useJournal.setState((state) => ({ entries: [...earlier, ...state.entries].slice(-maxEntries) }));
    })
    .catch((error) => console.error("journal: load failed", error));
  return loading;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void loadJournal()
      .then(() => backend.storeSet(storeName, JSON.stringify(useJournal.getState().entries)))
      .catch((error) => console.error("journal: save failed", error));
  }, saveDelayMs);
}

export function report(area: JournalArea, message: MessageKey, detail?: unknown): void {
  console.error(`${area}: ${message}`, detail ?? "");
  const text = detailText(detail);
  void backend.logWrite("error", `${area}: ${message}${text ? ` (${text})` : ""}`).catch(() => undefined);
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
