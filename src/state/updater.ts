import { create } from "zustand";
import type { ChangelogLine } from "../changelog";
import { backend, getAppInfo, isDesktop } from "../lib/backend";
import { isAppLanguage, type AppLanguage } from "../lib/languages";
import { report } from "../lib/journal";
import { runBeforeClose } from "../lib/lifecycle";
import { mpv } from "../lib/mpv";
import { flushLibrary } from "./library";

export interface UpdateChanges {
  version: string;
  lines: Partial<Record<AppLanguage, ChangelogLine[]>>;
}

export type UpdateStatus = "idle" | "checking" | "upToDate" | "available" | "downloading" | "installing" | "error";

interface UpdaterState {
  status: UpdateStatus;
  version: string;
  notes: string;
  changes: UpdateChanges[];
  progress: number;
  dismissed: boolean;
  check: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

type PendingUpdate = Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>>;

let pending: PendingUpdate = null;

function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function linesOf(value: unknown): ChangelogLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((line): ChangelogLine[] => {
    if (typeof line === "string") return line.trim() ? [line] : [];
    if (line && typeof line === "object" && typeof (line as { heading?: unknown }).heading === "string") return [{ heading: (line as { heading: string }).heading }];
    return [];
  });
}

export function changesOf(raw: Record<string, unknown> | undefined, installed: string, target: string): UpdateChanges[] {
  const changelog = raw?.changelog;
  if (!changelog || typeof changelog !== "object") return [];
  const changes: UpdateChanges[] = [];
  for (const [version, entry] of Object.entries(changelog)) {
    if (compareVersions(version, target) > 0 || (installed && compareVersions(version, installed) <= 0)) continue;
    if (!entry || typeof entry !== "object") continue;
    const lines: Partial<Record<AppLanguage, ChangelogLine[]>> = {};
    for (const [language, value] of Object.entries(entry)) {
      const parsed = linesOf(value);
      if (isAppLanguage(language) && parsed.length > 0) lines[language] = parsed;
    }
    if (Object.keys(lines).length > 0) changes.push({ version, lines });
  }
  return changes.sort((a, b) => compareVersions(b.version, a.version));
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: "idle",
  version: "",
  notes: "",
  changes: [],
  progress: 0,
  dismissed: false,

  async check() {
    if (!isDesktop || get().status === "checking" || get().status === "downloading") return;
    set({ status: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      pending = await check();
      if (pending) {
        const installed = (await getAppInfo().catch(() => null))?.version ?? pending.currentVersion ?? "";
        set({ status: "available", version: pending.version, notes: pending.body ?? "", changes: changesOf(pending.rawJson, installed, pending.version), dismissed: false });
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
      await runBeforeClose();
      await flushLibrary().catch((error) => report("updates", "journal.close.failed", error));
      if (mpv.supported) await mpv.quit().catch((error) => report("updates", "journal.close.failed", error));
      if (isDesktop) await backend.stopEngine().catch((error) => report("updates", "journal.close.failed", error));
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
