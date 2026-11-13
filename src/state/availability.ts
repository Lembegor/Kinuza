import { create } from "zustand";
import { backend, isDesktop } from "../lib/backend";
import { isVideoRelease, parseTrackerRelease, qualityRank } from "../lib/parse";
import { isServerError, rutracker, rutrackerErrors } from "../lib/rutracker";
import type { MediaItem } from "../lib/tmdb";
import { useUi } from "./ui";

const storeName = "availability";
const msPerHour = 3_600_000;
const foundMaxAgeMs = 72 * msPerHour;
const missingMaxAgeMs = 24 * msPerHour;
const gapMs = 1800;
const busyWaitMs = 5000;
const saveDelayMs = 3000;
const queueLimit = 24;

export interface Availability {
  found: boolean;
  quality: string;
  seeds: number;
  checkedAt: number;
}

interface AvailabilityState {
  known: Record<string, Availability>;
}

export const useAvailability = create<AvailabilityState>(() => ({ known: {} }));

let restored: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let queue: MediaItem[] = [];
let running = false;
let stoppedForSession = false;

function itemKey(item: Pick<MediaItem, "type" | "id">): string {
  return `${item.type}:${item.id}`;
}

function restore(): Promise<void> {
  restored ??= backend
    .storeGet(storeName)
    .then((document) => {
      const parsed: unknown = document ? JSON.parse(document.text) : {};
      if (typeof parsed === "object" && parsed !== null) useAvailability.setState({ known: parsed as Record<string, Availability> });
    })
    .catch(() => undefined);
  return restored;
}

function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void backend.storeSet(storeName, JSON.stringify(useAvailability.getState().known)).catch(() => undefined);
  }, saveDelayMs);
}

function isFresh(entry: Availability | undefined): boolean {
  if (!entry) return false;
  return Date.now() - entry.checkedAt < (entry.found ? foundMaxAgeMs : missingMaxAgeMs);
}

function trackerQuery(item: MediaItem): string {
  const readable = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{N}\p{P}\p{Zs}]+$/u.test(item.originalTitle);
  const name = readable && item.originalTitle ? item.originalTitle : item.title;
  return item.type === "movie" && item.year ? `${name} ${item.year}` : name;
}

async function check(item: MediaItem): Promise<Availability> {
  const results = await rutracker.search(trackerQuery(item), true, 0, true);
  let quality = "";
  let seeds = 0;
  for (const result of results) {
    if (result.seeds <= 0) continue;
    if (item.type === "movie" && item.year && !result.title.includes(item.year)) continue;
    const release = parseTrackerRelease(result.title);
    if (!isVideoRelease(release)) continue;
    const found = release.resolution || release.quality;
    if (qualityRank(found) > qualityRank(quality)) quality = found;
    seeds = Math.max(seeds, result.seeds);
  }
  return { found: seeds > 0, quality, seeds, checkedAt: Date.now() };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0 && !stoppedForSession) {
      if (useUi.getState().addSource) {
        await sleep(busyWaitMs);
        continue;
      }
      const item = queue.shift()!;
      if (isFresh(useAvailability.getState().known[itemKey(item)])) continue;
      try {
        const result = await check(item);
        useAvailability.setState((state) => ({ known: { ...state.known, [itemKey(item)]: result } }));
        save();
      } catch (error) {
        const code = String(error);
        if (isServerError(error) || code.includes(rutrackerErrors.authRequired) || code.includes(rutrackerErrors.cancelled) || code.includes(rutrackerErrors.timeout)) {
          stoppedForSession = true;
          queue = [];
          break;
        }
      }
      await sleep(gapMs);
    }
  } finally {
    running = false;
  }
}

export function checkAvailability(items: MediaItem[], first = false): void {
  if (!isDesktop && import.meta.env.PROD) return;
  void restore().then(() => {
    const known = useAvailability.getState().known;
    const wanted = items.filter((item) => !isFresh(known[itemKey(item)]));
    const wantedKeys = new Set(wanted.map(itemKey));
    const rest = queue.filter((item) => !wantedKeys.has(itemKey(item)));
    queue = first ? [...wanted, ...rest] : [...rest, ...wanted];
    queue = queue.slice(0, queueLimit);
    void run();
  });
}

export function availabilityOf(known: Record<string, Availability>, item: Pick<MediaItem, "type" | "id">): Availability | null {
  const entry = known[itemKey(item)];
  return entry?.found ? entry : null;
}

export function checkedOf(known: Record<string, Availability>, item: Pick<MediaItem, "type" | "id">): Availability | null {
  return known[itemKey(item)] ?? null;
}

export function loadAvailability(): void {
  void restore();
}
