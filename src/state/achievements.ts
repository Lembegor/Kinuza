import { create } from "zustand";
import { achievementDefs, computeAchievements, type AchievementState } from "../lib/achievements";
import { backend } from "../lib/backend";
import { isRecord } from "../lib/account";
import { report } from "../lib/journal";
import { useAccount } from "./account";
import { onActivityChange } from "./activity";
import { useLibrary } from "./library";
import { useProfile } from "./profile";
import { buildLedgerNow } from "./stats";
import { useUi } from "./ui";

const storeName = "achievements";
const storeVersion = 1;
const firstCheckMs = 6000;
const settleMs = 4000;

export interface Celebration {
  id: string;
  tier: number;
}

export interface Welcome {
  count: number;
  ids: string[];
}

interface Saved {
  version: number;
  seen: Record<string, number>;
  dates: Record<string, (number | null)[]>;
}

interface AchievementsStore {
  shown: AchievementState[] | null;
  queue: Celebration[];
  welcome: Welcome | null;
  dropCelebration: () => void;
  dropWelcome: () => void;
}

export const useAchievements = create<AchievementsStore>((set) => ({
  shown: null,
  queue: [],
  welcome: null,
  dropCelebration: () => set((state) => ({ queue: state.queue.slice(1) })),
  dropWelcome: () => set({ welcome: null }),
}));

let saved: Saved | null = null;
let loaded = false;
let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

function readSaved(text: string | undefined): Saved | null {
  if (text === undefined) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    const seen: Record<string, number> = {};
    const dates: Record<string, (number | null)[]> = {};
    if (isRecord(value.seen)) for (const [id, tier] of Object.entries(value.seen)) if (typeof tier === "number" && tier >= 0) seen[id] = tier;
    if (isRecord(value.dates))
      for (const [id, list] of Object.entries(value.dates))
        if (Array.isArray(list)) dates[id] = list.map((item) => (typeof item === "number" ? item : null));
    return { version: storeVersion, seen, dates };
  } catch {
    return null;
  }
}

function merge(states: AchievementState[], memory: Saved, now: number): { shown: AchievementState[]; fresh: Celebration[] } {
  const fresh: Celebration[] = [];
  const shown = states.map((state) => {
    const before = memory.seen[state.def.id] ?? 0;
    const tier = Math.max(before, state.tier);
    const dates = memory.dates[state.def.id] ?? [];
    const unlocked = Array.from({ length: tier }, (_, index) => state.unlocked[index] ?? dates[index] ?? now);
    for (let index = before; index < state.tier; index++) fresh.push({ id: state.def.id, tier: index + 1 });
    memory.seen[state.def.id] = tier;
    memory.dates[state.def.id] = unlocked;
    return { ...state, tier, unlocked };
  });
  return { shown, fresh };
}

async function check(): Promise<void> {
  const library = useLibrary.getState();
  const profile = useProfile.getState();
  if (!library.loaded || !profile.loaded || library.firstRun || useUi.getState().player) return;
  if (!loaded) {
    const document = await backend.storeGet(storeName);
    saved = readSaved(document?.text);
    loaded = true;
  }
  const ledger = await buildLedgerNow();
  if (!ledger) return;
  const account = useAccount.getState();
  const friends = account.phase === "signedIn" ? (account.social?.friends.length ?? 0) : 0;
  const now = Date.now();
  const states = computeAchievements(ledger, { friends, now });
  const first = saved === null;
  const memory: Saved = saved ?? { version: storeVersion, seen: {}, dates: {} };
  const { shown, fresh } = merge(states, memory, now);
  saved = memory;
  await backend.storeSet(storeName, JSON.stringify(memory));
  if (first) {
    const earned = shown.filter((state) => state.tier > 0);
    const count = earned.reduce((sum, state) => sum + state.tier, 0);
    useAchievements.setState({
      shown,
      welcome: count > 0 ? { count, ids: earned.sort((a, b) => b.tier - a.tier).map((state) => state.def.id).slice(0, 5) } : null,
    });
    return;
  }
  useAchievements.setState((state) => ({ shown, queue: [...state.queue, ...fresh] }));
}

export function checkAchievements(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = check()
    .catch((error) => report("library", "journal.achievements.failed", error))
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        scheduleCheck();
      }
    });
  return running;
}

function scheduleCheck(delay = settleMs): void {
  clearTimeout(timer);
  timer = setTimeout(() => void checkAchievements(), delay);
}

export function startAchievements(): void {
  if (started) return;
  started = true;
  scheduleCheck(firstCheckMs);
  useUi.subscribe((state, previous) => {
    if (previous.player && !state.player) scheduleCheck();
  });
  useLibrary.subscribe((state, previous) => {
    if (state.tracked !== previous.tracked) scheduleCheck();
  });
  useAccount.subscribe((state, previous) => {
    if ((state.social?.friends.length ?? 0) !== (previous.social?.friends.length ?? 0)) scheduleCheck();
  });
  onActivityChange(() => scheduleCheck());
}

export function achievementById(id: string) {
  return achievementDefs.find((def) => def.id === id) ?? null;
}
