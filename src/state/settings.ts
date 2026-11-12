import { create } from "zustand";
import { backend } from "../lib/backend";
import { isLinux } from "../lib/platform";
import { t } from "../lib/i18n";
import { report } from "../lib/journal";
import type { AppLanguage } from "../lib/languages";
import { setApiKeyOverride, setCatalogLanguage } from "../lib/tmdb";
import { useUi } from "./ui";

const storeName = "settings";
const currentVersion = 3;
const fallbackCatalogLanguage = "en";

export type TrackerSort = "best" | "seeds" | "sizeDesc" | "sizeAsc";

export interface TrackerPrefs {
  resolutions: string[];
  voices: string[];
  videoOnly: boolean;
  sort: TrackerSort;
}

export type AudioMode = "off" | "night" | "level" | "dialogue";
export type SubtitleFont = "sans" | "serif" | "rounded" | "condensed";
export type SubtitleColor = "white" | "yellow" | "cyan" | "green";
export type SubtitleBackground = "outline" | "shadow" | "box";
export type VideoQuality = "high" | "balanced" | "fast";
export type SpoilerMode = "show" | "blur" | "hide";
export type GridDensity = "compact" | "normal" | "large";

export interface Settings {
  downloadDir: string;
  autoUpdate: boolean;
  tmdbKey: string;
  volume: number;
  muted: boolean;
  subtitleScale: number;
  autoNextEpisode: boolean;
  smoothMotion: boolean;
  preferredQuality: number;
  handleLinks: boolean;
  linksPrompted: boolean;
  trackerPrefs: TrackerPrefs;
  language: AppLanguage | "";
  audioLanguage: string;
  subtitleLanguage: string;
  downloadLimit: number;
  uploadLimit: number;
  maxActiveDownloads: number;
  seedRatio: number;
  cacheLimitGb: number;
  autoDeleteWatched: boolean;
  closeToTray: boolean;
  notifyDownloads: boolean;
  notifyEpisodes: boolean;
  autoAddEpisodes: boolean;
  audioMode: AudioMode;
  subtitleFont: SubtitleFont;
  subtitleColor: SubtitleColor;
  subtitleBackground: SubtitleBackground;
  subtitlePosition: number;
  videoQuality: VideoQuality;
  autoSimplify: boolean;
  spoilerDescriptions: SpoilerMode;
  spoilerStills: boolean;
  gridDensity: GridDensity;
  accent: string;
  version: number;
}

const defaults: Settings = {
  downloadDir: "",
  autoUpdate: true,
  tmdbKey: "",
  volume: 1,
  muted: false,
  subtitleScale: 1,
  autoNextEpisode: true,
  smoothMotion: false,
  preferredQuality: 0,
  handleLinks: false,
  linksPrompted: false,
  trackerPrefs: { resolutions: [], voices: [], videoOnly: true, sort: "best" },
  language: "",
  audioLanguage: "",
  subtitleLanguage: "",
  downloadLimit: 0,
  uploadLimit: 0,
  maxActiveDownloads: 0,
  seedRatio: 0,
  cacheLimitGb: 20,
  autoDeleteWatched: false,
  closeToTray: !isLinux,
  notifyDownloads: true,
  notifyEpisodes: true,
  autoAddEpisodes: true,
  audioMode: "off",
  subtitleFont: "sans",
  subtitleColor: "white",
  subtitleBackground: "outline",
  subtitlePosition: 0,
  videoQuality: "high",
  autoSimplify: true,
  spoilerDescriptions: "blur",
  spoilerStills: false,
  gridDensity: "normal",
  accent: "",
  version: currentVersion,
};

function upgrade(stored: Partial<Settings>): Partial<Settings> {
  const version = stored.version ?? 1;
  if (version >= currentVersion) return stored;
  const upgraded: Partial<Settings> = { ...stored, version: currentVersion };
  if (version < 2 && stored.trackerPrefs?.sort === "seeds") upgraded.trackerPrefs = { ...stored.trackerPrefs, sort: "best" };
  if (version < 3) upgraded.closeToTray = !isLinux;
  return upgraded;
}

const bytesPerKilobyte = 1024;
const policyKeys = ["downloadLimit", "uploadLimit", "maxActiveDownloads", "seedRatio", "cacheLimitGb"] as const;

function applyDownloadPolicy(settings: Settings): void {
  backend
    .setDownloadPolicy({
      downloadLimit: settings.downloadLimit * bytesPerKilobyte,
      uploadLimit: settings.uploadLimit * bytesPerKilobyte,
      maxActiveDownloads: settings.maxActiveDownloads,
      seedRatio: settings.seedRatio,
      cacheLimitGb: settings.cacheLimitGb,
    })
    .catch((error) => report("downloads", "journal.settings.policy", error));
}

interface SettingsState extends Settings {
  loaded: boolean;
  load: () => Promise<void>;
  patch: (change: Partial<Settings>) => void;
}

let earlyChanges: Partial<Settings> = {};
let savingBlocked = false;
let saveFailureShown = false;

function persist(settings: Settings): void {
  if (savingBlocked) return;
  backend.storeSet(storeName, JSON.stringify(settings)).then(
    () => {
      saveFailureShown = false;
    },
    (error) => {
      report("settings", "journal.settings.save", error);
      if (saveFailureShown) return;
      saveFailureShown = true;
      useUi.getState().toast(t("settings.saveFailed"), "error");
    },
  );
}

function currentSettings(state: SettingsState): Settings {
  const { loaded: _loaded, load: _load, patch: _patch, ...settings } = state;
  return settings;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...defaults,
  loaded: false,

  async load() {
    try {
      const document = await backend.storeGet(storeName);
      const parsed: unknown = document ? JSON.parse(document.text) : {};
      const stored: Partial<Settings> = upgrade(typeof parsed === "object" && parsed !== null ? (parsed as Partial<Settings>) : {});
      set({ ...defaults, ...stored, ...earlyChanges, loaded: true });
      if (Object.keys(earlyChanges).length > 0) persist(currentSettings(get()));
    } catch (error) {
      savingBlocked = true;
      report("settings", "journal.settings.load", error);
      set({ ...earlyChanges, loaded: true });
      useUi.getState().toast(t("settings.loadFailed"), "error");
    }
    earlyChanges = {};
    setApiKeyOverride(get().tmdbKey);
    setCatalogLanguage(get().language || fallbackCatalogLanguage);
    applyDownloadPolicy(get());
  },

  patch(change) {
    set(change);
    if ("tmdbKey" in change) setApiKeyOverride(get().tmdbKey);
    if ("language" in change) setCatalogLanguage(get().language || fallbackCatalogLanguage);
    if (!get().loaded) {
      earlyChanges = { ...earlyChanges, ...change };
      return;
    }
    if (policyKeys.some((key) => key in change)) applyDownloadPolicy(get());
    savingBlocked = false;
    persist(currentSettings(get()));
  },
}));
