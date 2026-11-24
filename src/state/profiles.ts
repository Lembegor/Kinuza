import { create } from "zustand";
import { backend, freezePersonalWrites, thawPersonalWrites, type ProfileEntry, type ProfilesView } from "../lib/backend";
import { runBeforeClose } from "../lib/lifecycle";
import { report } from "../lib/journal";
import { flushLibrary } from "./library";
import { useProfile } from "./profile";
import { useUi } from "./ui";

export const profileColors = ["red", "orange", "yellow", "green", "teal", "blue", "violet", "pink"] as const;
export type ProfileColor = (typeof profileColors)[number];

const settleMs = 700;
const pickedKey = "kinuza-profile-picked";

interface ProfilesState {
  view: ProfilesView | null;
  switching: string | null;
  load: () => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  create: (name: string, color: ProfileColor) => Promise<string>;
  update: (id: string, change: { name?: string; color?: ProfileColor }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setAsk: (ask: boolean) => Promise<void>;
}

export const useProfiles = create<ProfilesState>((set, get) => ({
  view: null,
  switching: null,

  async load() {
    try {
      set({ view: await backend.profilesList() });
    } catch (error) {
      report("system", "journal.profiles.failed", error);
    }
  },

  async switchTo(id) {
    const view = get().view;
    if (!view || get().switching) return;
    if (id === view.active) {
      markPicked();
      return;
    }
    set({ switching: id });
    try {
      useUi.getState().closePlayer();
      await runBeforeClose();
      await flushLibrary();
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      freezePersonalWrites();
      await backend.profilesSwitch(id);
      markPicked();
      window.location.reload();
    } catch (error) {
      thawPersonalWrites();
      set({ switching: null });
      report("system", "journal.profiles.failed", error);
      throw error;
    }
  },

  async create(name, color) {
    const id = await backend.profilesCreate(name, color);
    await get().load();
    return id;
  },

  async update(id, change) {
    await backend.profilesUpdate(id, change);
    if (id === get().view?.active && change.name !== undefined) useProfile.getState().patch({ name: change.name });
    await get().load();
  },

  async remove(id) {
    await backend.profilesRemove(id);
    await get().load();
  },

  async setAsk(ask) {
    await backend.profilesSetAsk(ask);
    await get().load();
  },
}));

export function activeProfile(view: ProfilesView | null): ProfileEntry | null {
  return view?.profiles.find((entry) => entry.id === view.active) ?? null;
}

function markPicked(): void {
  try {
    sessionStorage.setItem(pickedKey, "1");
  } catch {
    return;
  }
}

export function pickedThisRun(): boolean {
  try {
    return sessionStorage.getItem(pickedKey) === "1";
  } catch {
    return true;
  }
}

export function notePicked(): void {
  markPicked();
}
