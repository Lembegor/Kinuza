import { create } from "zustand";
import { backend } from "../lib/backend";
import { report } from "../lib/journal";
import type { AppLanguage } from "../lib/languages";
import { setApiKeyOverride, setCatalogLanguage } from "../lib/tmdb";

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

export interface Settings {
  downloadDir: string;
  autoUpdate: boolean;
  tmdbKey: string;
  volume: number;
  muted: boolean;
  subtitleScale: number;
  autoNextEpisode: boolean;
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
  closeToTray: true,
  notifyDownloads: true,
  notifyEpisodes: true,
  autoAddEpisodes: true,
  version: currentVersion,
};

function upgrade(stored: Partial<Settings>): Partial<Settings> {
  const version = stored.version ?? 1;
  if (version >= currentVersion) return stored;
  const upgraded: Partial<Settings> = { ...stored, version: currentVersion };
  if (version < 2 && stored.trackerPrefs?.sort === "seeds") upgraded.trackerPrefs = { ...stored.trackerPrefs, sort: "best" };
  if (version < 3) upgraded.closeToTray = true;
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

export const useSettings = create<SettingsState>((set, get) => ({
  ...defaults,
  loaded: false,

  async load() {
    try {
      const text = await backend.storeGet(storeName);
      const stored: Partial<Settings> = upgrade(text ? JSON.parse(text) : {});
      set({ ...defaults, ...stored, loaded: true });
    } catch (error) {
      report("settings", "journal.settings.load", error);
      set({ loaded: true });
    }
    setApiKeyOverride(get().tmdbKey);
    setCatalogLanguage(get().language || fallbackCatalogLanguage);
    applyDownloadPolicy(get());
  },

  patch(change) {
    set(change);
    if ("tmdbKey" in change) setApiKeyOverride(get().tmdbKey);
    if ("language" in change) setCatalogLanguage(get().language || fallbackCatalogLanguage);
    if (policyKeys.some((key) => key in change)) applyDownloadPolicy(get());
    const { loaded: _loaded, load: _load, patch: _patch, ...settings } = get();
    backend
      .storeSet(storeName, JSON.stringify(settings))
      .catch((error) => report("settings", "journal.settings.save", error));
  },
}));
