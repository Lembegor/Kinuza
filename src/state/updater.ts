// In-app updates: check the release feed, download the signed installer, restart into the new version.

import { create } from "zustand";
import { isDesktop } from "../lib/backend";
import { report } from "../lib/journal";
import { flushLibrary } from "./library";

export type UpdateStatus = "idle" | "checking" | "upToDate" | "available" | "downloading" | "installing" | "error";

interface UpdaterState {
  status: UpdateStatus;
  version: string;
  notes: string;
  /** Download progress, 0..1. */
  progress: number;
  dismissed: boolean;
  check: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

type PendingUpdate = Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>>;

let pending: PendingUpdate = null;

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: "idle",
  version: "",
  notes: "",
  progress: 0,
  dismissed: false,

  async check() {
    if (!isDesktop || get().status === "checking" || get().status === "downloading") return;
    set({ status: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      pending = await check();
      if (pending) {
        set({ status: "available", version: pending.version, notes: pending.body ?? "", dismissed: false });
      } else {
        set({ status: "upToDate" });
      }
    } catch (error) {
      report("updates", "journal.updates.check", error);
      set({ status: "error" });
    }
  },

  async install() {
    if (!pending) return;
    set({ status: "downloading", progress: 0 });
    try {
      let total = 0;
      let received = 0;
      await pending.download((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total > 0) set({ progress: received / total });
        }
        if (event.event === "Finished") set({ status: "installing", progress: 1 });
      });
      // The installer closes the app by itself, without the usual goodbye: what has been watched
      // and rated is written down first.
      await flushLibrary().catch((error) => report("updates", "journal.close.failed", error));
      await pending.install();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      report("updates", "journal.updates.install", error);
      set({ status: "error" });
    }
  },

  dismiss: () => set({ dismissed: true }),
}));
