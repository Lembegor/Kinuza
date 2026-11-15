import { backend } from "../lib/backend";
import { beforeAppClose } from "../lib/lifecycle";
import { recordActivity } from "./activity";

const storeName = "taste-impressions";
const keepLimit = 4000;
const saveDelayMs = 5000;
const msPerDay = 86_400_000;

export interface Impression {
  key: string;
  first: number;
  last: number;
  count: number;
  opened?: number;
  x?: number[];
  arm?: string;
  row?: string;
}

export interface ShownItem {
  type: string;
  id: number;
  title?: string;
  year?: string;
  signals?: number[];
  arm?: string;
}

let impressions: Map<string, Impression> | null = null;
let loading: Promise<Map<string, Impression>> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let removeCloseTask: (() => void) | null = null;

export function loadImpressions(): Promise<Map<string, Impression>> {
  loading ??= backend
    .storeGet(storeName)
    .then((document) => {
      const parsed: unknown = document ? JSON.parse(document.text) : [];
      const list = Array.isArray(parsed) ? (parsed as Impression[]) : [];
      return new Map(list.filter((entry) => typeof entry?.key === "string").map((entry) => [entry.key, entry]));
    })
    .catch(() => new Map<string, Impression>())
    .then((map) => {
      impressions = map;
      return map;
    });
  return loading;
}

function save(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  removeCloseTask?.();
  removeCloseTask = null;
  if (!impressions) return Promise.resolve();
  const list = [...impressions.values()].sort((a, b) => b.last - a.last).slice(0, keepLimit);
  return backend.storeSet(storeName, JSON.stringify(list), true).catch(() => undefined);
}

function scheduleSave(): void {
  if (saveTimer !== undefined) return;
  saveTimer = setTimeout(() => void save(), saveDelayMs);
  removeCloseTask = beforeAppClose(save);
}

export function noteShown(item: ShownItem, row: string): void {
  void loadImpressions().then((map) => {
    const key = `${item.type}:${item.id}`;
    const now = Date.now();
    const known = map.get(key);
    if (known && Math.floor(known.last / msPerDay) === Math.floor(now / msPerDay)) return;
    map.set(key, {
      key,
      first: known?.first ?? now,
      last: now,
      count: (known?.count ?? 0) + 1,
      opened: known?.opened,
      x: known?.x ?? item.signals,
      arm: known?.arm ?? item.arm,
      row: known?.row ?? row,
    });
    scheduleSave();
  });
}

export function noteOpened(item: ShownItem, row: string): void {
  recordActivity("feed.open", { title: { type: item.type, id: item.id, name: item.title ?? "", year: item.year ?? "" }, row });
  void loadImpressions().then((map) => {
    const key = `${item.type}:${item.id}`;
    const now = Date.now();
    const known = map.get(key);
    map.set(key, {
      key,
      first: known?.first ?? now,
      last: known?.last ?? now,
      count: known?.count ?? 1,
      opened: known?.opened ?? now,
      x: known?.x ?? item.signals,
      arm: known?.arm ?? item.arm,
      row: known?.row ?? row,
    });
    scheduleSave();
  });
}
