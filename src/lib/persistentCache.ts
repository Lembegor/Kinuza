import { backend } from "./backend";
import { catalogLanguage } from "./tmdb";

const storeName = "catalog-cache";
const maxEntries = 320;
const saveDelayMs = 4000;

interface Entry {
  at: number;
  value: unknown;
}

let entries: Map<string, Entry> | null = null;
let loading: Promise<Map<string, Entry>> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const inFlight = new Map<string, Promise<unknown>>();

function load(): Promise<Map<string, Entry>> {
  loading ??= backend
    .storeGet(storeName)
    .then((document) => {
      const parsed: unknown = document ? JSON.parse(document.text) : {};
      const map = new Map<string, Entry>();
      if (typeof parsed === "object" && parsed !== null) {
        for (const [key, entry] of Object.entries(parsed as Record<string, Entry>)) {
          if (entry && typeof entry.at === "number") map.set(key, entry);
        }
      }
      return map;
    })
    .catch(() => new Map<string, Entry>());
  return loading;
}

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!entries) return;
    void backend.storeSet(storeName, JSON.stringify(Object.fromEntries(entries))).catch(() => undefined);
  }, saveDelayMs);
}

function remember(key: string, value: unknown): void {
  if (!entries) return;
  entries.delete(key);
  entries.set(key, { at: Date.now(), value });
  while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
  scheduleSave();
}

export async function cachedCatalog<T>(name: string, maxAgeMs: number, loader: () => Promise<T>): Promise<T> {
  entries ??= await load();
  const key = `${catalogLanguage()}:${name}`;
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value as T;
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;
  const request = loader()
    .then((value) => {
      remember(key, value);
      return value;
    })
    .catch((error) => {
      if (hit) return hit.value as T;
      throw error;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}
