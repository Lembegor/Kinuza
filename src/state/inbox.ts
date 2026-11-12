import { create } from "zustand";
import { backend } from "../lib/backend";
import { report } from "../lib/journal";

const storeName = "inbox";
const keptItems = 100;
const keptForMs = 60 * 24 * 60 * 60 * 1000;
const saveDelayMs = 800;

export type InboxKind = "episodes" | "download" | "update" | "info";

export interface InboxItem {
  id: string;
  kind: InboxKind;
  title: string;
  body: string;
  link?: string;
  at: number;
  read: boolean;
}

interface InboxState {
  items: InboxItem[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (item: Omit<InboxItem, "id" | "at" | "read">) => void;
  markAllRead: () => void;
  markRead: (id: string) => void;
  clear: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingBeforeLoad: InboxItem[] = [];

function isItem(value: unknown): value is InboxItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.title === "string" && typeof item.at === "number";
}

function fresh(items: InboxItem[]): InboxItem[] {
  const now = Date.now();
  return items.filter((item) => now - item.at < keptForMs).slice(0, keptItems);
}

function save(items: InboxItem[]): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void backend.storeSet(storeName, JSON.stringify({ version: 1, items })).catch((error) => report("system", "journal.inbox.save", error));
  }, saveDelayMs);
}

export const useInbox = create<InboxState>((set, get) => {
  const replace = (items: InboxItem[]) => {
    const kept = fresh(items);
    set({ items: kept });
    if (get().loaded) save(kept);
  };

  return {
    items: [],
    loaded: false,

    async load() {
      try {
        const document = await backend.storeGet(storeName);
        const parsed: unknown = document ? JSON.parse(document.text) : null;
        const stored = parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items.filter(isItem) : [];
        set({ items: fresh([...pendingBeforeLoad, ...stored]), loaded: true });
        if (pendingBeforeLoad.length > 0) save(get().items);
      } catch (error) {
        report("system", "journal.inbox.load", error);
        set({ items: fresh(pendingBeforeLoad), loaded: true });
      }
      pendingBeforeLoad = [];
    },

    add(item) {
      const entry: InboxItem = { ...item, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), read: false };
      if (!get().loaded) pendingBeforeLoad = [entry, ...pendingBeforeLoad];
      replace([entry, ...get().items]);
    },

    markAllRead() {
      if (get().items.every((item) => item.read)) return;
      replace(get().items.map((item) => ({ ...item, read: true })));
    },

    markRead(id) {
      replace(get().items.map((item) => (item.id === id ? { ...item, read: true } : item)));
    },

    clear() {
      replace([]);
    },
  };
});
