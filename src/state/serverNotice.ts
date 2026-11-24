import { create } from "zustand";
import { hasOwnAccount, onServerBlocked, rutracker, serverProblemOfState } from "../lib/rutracker";

const storageKey = "kinuza-rutracker-notice";
const repeatMs = 24 * 3600_000;
const firstCheckMs = 20_000;
const recheckMs = 30 * 60_000;

interface Saved {
  shownAt: number;
  never: boolean;
}

function saved(): Saved {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Partial<Saved>;
    return { shownAt: Number(value.shownAt) || 0, never: value.never === true };
  } catch {
    return { shownAt: 0, never: false };
  }
}

function save(next: Saved): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    return;
  }
}

interface ServerNoticeState {
  open: boolean;
  offer: () => Promise<void>;
  markShown: () => void;
  close: () => void;
  never: () => void;
  recheckRoute: () => Promise<void>;
}

export const useServerNotice = create<ServerNoticeState>((set, get) => ({
  open: false,
  offer: async () => {
    if (get().open) return;
    const state = saved();
    if (state.never || Date.now() - state.shownAt < repeatMs) return;
    if (await hasOwnAccount()) return;
    set({ open: true });
  },
  markShown: () => save({ ...saved(), shownAt: Date.now() }),
  close: () => set({ open: false }),
  never: () => {
    save({ ...saved(), never: true });
    set({ open: false });
  },
  recheckRoute: async () => {
    if (!get().open) return;
    if (await hasOwnAccount()) set({ open: false });
  },
}));

async function check(): Promise<void> {
  const status = await rutracker.serverStatus();
  if (serverProblemOfState(status.state) === "login") await useServerNotice.getState().offer();
}

let started = false;

export function startServerNotice(): void {
  if (started) return;
  started = true;
  onServerBlocked(() => void useServerNotice.getState().offer());
  setTimeout(() => void check(), firstCheckMs);
  setInterval(() => void check(), recheckMs);
  window.addEventListener("focus", () => void useServerNotice.getState().recheckRoute());
}
