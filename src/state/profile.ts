import { create } from "zustand";
import { backend } from "../lib/backend";
import { isRecord } from "../lib/account";

const storeName = "profile";
const saveDelayMs = 400;
const busyRetryMs = 3000;
const busyAttempts = 40;
const profileVersion = 1;

export type HistoryRetention = "forever" | "year" | "quarter";

export interface MonthTotals {
  movie: number;
  tv: number;
  anime: number;
}

export interface ProfileData {
  version: number;
  id: string;
  name: string;
  avatar: string | null;
  cover: string | null;
  createdAt: number;
  updatedAt: number;
  historyPaused: boolean;
  retention: HistoryRetention;
  hidden: Record<string, number>;
  dismissedCards: string[];
  archive: Record<string, MonthTotals>;
  journalSince: number | null;
}

interface ProfileState extends ProfileData {
  loaded: boolean;
  deviceId: string;
  load: (attempt?: number) => Promise<void>;
  patch: (change: Partial<Omit<ProfileData, "version" | "id" | "createdAt" | "updatedAt">>) => void;
  hideTitle: (key: string) => void;
  showTitle: (key: string) => void;
  dismissCard: (card: string) => void;
  noteJournalSince: (at: number) => void;
  exportProfile: () => ProfileData;
  mergeProfile: (other: unknown) => void;
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fresh(now = Date.now()): ProfileData {
  return {
    version: profileVersion,
    id: randomId(),
    name: "",
    avatar: null,
    cover: null,
    createdAt: now,
    updatedAt: now,
    historyPaused: false,
    retention: "forever",
    hidden: {},
    dismissedCards: [],
    archive: {},
    journalSince: null,
  };
}

function numberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "number")) as Record<string, number>;
}

function archiveOf(value: unknown): Record<string, MonthTotals> {
  if (!isRecord(value)) return {};
  const result: Record<string, MonthTotals> = {};
  for (const [month, item] of Object.entries(value)) {
    if (!isRecord(item)) continue;
    result[month] = { movie: Number(item.movie) || 0, tv: Number(item.tv) || 0, anime: Number(item.anime) || 0 };
  }
  return result;
}

export function parseProfile(raw: unknown): ProfileData | null {
  if (!isRecord(raw) || typeof raw.id !== "string") return null;
  const base = fresh();
  return {
    version: profileVersion,
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name.slice(0, 40) : "",
    avatar: typeof raw.avatar === "string" && raw.avatar.startsWith("data:image/") ? raw.avatar : null,
    cover: typeof raw.cover === "string" ? raw.cover : null,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    historyPaused: raw.historyPaused === true,
    retention: raw.retention === "year" || raw.retention === "quarter" ? raw.retention : "forever",
    hidden: numberRecord(raw.hidden),
    dismissedCards: Array.isArray(raw.dismissedCards) ? raw.dismissedCards.filter((item): item is string => typeof item === "string").slice(-50) : [],
    archive: archiveOf(raw.archive),
    journalSince: typeof raw.journalSince === "number" ? raw.journalSince : null,
  };
}

export function mergeProfiles(ours: ProfileData, theirs: ProfileData): ProfileData {
  const newer = theirs.updatedAt > ours.updatedAt ? theirs : ours;
  const hidden = { ...ours.hidden };
  for (const [key, at] of Object.entries(theirs.hidden)) hidden[key] = Math.max(hidden[key] ?? 0, at);
  const archive = { ...ours.archive };
  for (const [month, totals] of Object.entries(theirs.archive)) {
    const known = archive[month];
    archive[month] = known
      ? { movie: Math.max(known.movie, totals.movie), tv: Math.max(known.tv, totals.tv), anime: Math.max(known.anime, totals.anime) }
      : totals;
  }
  const since = [ours.journalSince, theirs.journalSince].filter((value): value is number => value !== null);
  return {
    ...newer,
    id: ours.id,
    createdAt: Math.min(ours.createdAt, theirs.createdAt),
    hidden,
    archive,
    dismissedCards: [...new Set([...ours.dismissedCards, ...theirs.dismissedCards])].slice(-50),
    journalSince: since.length > 0 ? Math.min(...since) : null,
  };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function dataOf(state: ProfileState): ProfileData {
  const { version, id, name, avatar, cover, createdAt, updatedAt, historyPaused, retention, hidden, dismissedCards, archive, journalSince } = state;
  return { version, id, name, avatar, cover, createdAt, updatedAt, historyPaused, retention, hidden, dismissedCards, archive, journalSince };
}

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const state = useProfile.getState();
    void backend.storeSet(storeName, JSON.stringify({ ...dataOf(state), deviceId: state.deviceId })).catch(() => undefined);
  }, saveDelayMs);
}

export const useProfile = create<ProfileState>((set, get) => {
  const change = (next: Partial<ProfileData>) => {
    if (!get().loaded) return;
    set({ ...next, updatedAt: Date.now() });
    scheduleSave();
  };

  return {
    ...fresh(),
    loaded: false,
    deviceId: "",

    async load(attempt = 0) {
      let stored: unknown = null;
      try {
        const document = await backend.storeGet(storeName);
        stored = document ? JSON.parse(document.text) : null;
      } catch (error) {
        if (String(error).includes("store_busy") && attempt < busyAttempts) {
          setTimeout(() => void get().load(attempt + 1), busyRetryMs);
          return;
        }
        stored = null;
      }
      const parsed = parseProfile(stored);
      const deviceId = isRecord(stored) && typeof stored.deviceId === "string" ? stored.deviceId : randomId();
      set({ ...(parsed ?? fresh()), deviceId, loaded: true });
      if (!parsed || !isRecord(stored) || stored.deviceId !== deviceId) scheduleSave();
    },

    patch: (next) => change(next),
    hideTitle: (key) => change({ hidden: { ...get().hidden, [key]: Date.now() } }),
    showTitle: (key) => {
      const hidden = { ...get().hidden };
      delete hidden[key];
      change({ hidden });
    },
    dismissCard: (card) => change({ dismissedCards: [...get().dismissedCards.filter((item) => item !== card), card].slice(-50) }),
    noteJournalSince: (at) => {
      if (!get().loaded || get().journalSince !== null) return;
      set({ journalSince: at });
      scheduleSave();
    },
    exportProfile: () => dataOf(get()),
    mergeProfile(other) {
      const parsed = parseProfile(other);
      if (!parsed || !get().loaded) return;
      set(mergeProfiles(dataOf(get()), parsed));
      scheduleSave();
    },
  };
});

export function profileInitial(name: string, fallback: string): string {
  const letter = (name.trim() || fallback).charAt(0);
  return letter.toLocaleUpperCase();
}
