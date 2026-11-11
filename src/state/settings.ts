import { create } from "zustand";
import { backend } from "../lib/backend";
import { report } from "../lib/journal";
import type { AppLanguage } from "../lib/languages";
import { setApiKeyOverride, setCatalogLanguage } from "../lib/tmdb";

const storeName = "settings";
const currentVersion = 3;
/** The catalog's language until the user has chosen one: the first language on offer. */
const fallbackCatalogLanguage = "en";

/** "best" weighs resolution, language and seeds together; the others order by one thing. */
export type TrackerSort = "best" | "seeds" | "sizeDesc" | "sizeAsc";

/** How the user likes tracker search results narrowed down; kept between searches and launches. */
export interface TrackerPrefs {
  /** Ids of the resolution chips that are on; none means any resolution. */
  resolutions: string[];
  /** Ids of the voice-over and subtitle chips that are on. */
  voices: string[];
  /** Hide soundtracks, games and other releases without video. */
  videoOnly: boolean;
  sort: TrackerSort;
}

export interface Settings {
  /** Empty means the default folder reported by the backend. */
  downloadDir: string;
  autoUpdate: boolean;
  /** Empty means the key baked into the build. */
  tmdbKey: string;
  volume: number;
  muted: boolean;
  subtitleScale: number;
  autoNextEpisode: boolean;
  /** Highest quality to start with when a title has several sources; 0 means the best available. */
  preferredQuality: number;
  /** Kinuza opens magnet links and .torrent files clicked in the browser or Explorer. */
  handleLinks: boolean;
  /** The one-time question about handling links has been shown. */
  linksPrompted: boolean;
  trackerPrefs: TrackerPrefs;
  /** Interface language; empty until the user has chosen one on first start. */
  language: AppLanguage | "";
  /** Voice-over language films start in: a two-letter code; empty means each film's original language. */
  audioLanguage: string;
  /** Subtitle language films start with: a two-letter code, "off" for none; empty means the interface language. */
  subtitleLanguage: string;
  /** Kilobytes per second for all downloads together; 0 means no limit. */
  downloadLimit: number;
  uploadLimit: number;
  /** Torrents downloading at once, the rest queue up; 0 means all at once. */
  maxActiveDownloads: number;
  /** Seeding stops once a torrent has given back this share of its size; 0 means never. */
  seedRatio: number;
  /** Delete a download from disk once everything attached to it has been watched. */
  autoDeleteWatched: boolean;
  /** Closing the window hides it to the notification area; downloads go on. */
  closeToTray: boolean;
  /** Show a system notification when a download finishes. */
  notifyDownloads: boolean;
  /** Show a system notification when a followed series gets a new episode. */
  notifyEpisodes: boolean;
  /** Take new episodes from the tracker release a series was added from, as they appear there. */
  autoAddEpisodes: boolean;
  /** Which generation of defaults these settings were written with; see `upgrade`. */
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
  autoDeleteWatched: false,
  closeToTray: true,
  notifyDownloads: true,
  notifyEpisodes: true,
  autoAddEpisodes: true,
  version: currentVersion,
};

/** Brings settings saved by an older version of the app up to date. */
function upgrade(stored: Partial<Settings>): Partial<Settings> {
  const version = stored.version ?? 1;
  if (version >= currentVersion) return stored;
  // Version 2 introduced "best first" for tracker results; before it, ordering by seeders was
  // the only default there was, not something the user had chosen.
  const upgraded: Partial<Settings> = { ...stored, version: currentVersion };
  if (version < 2 && stored.trackerPrefs?.sort === "seeds") upgraded.trackerPrefs = { ...stored.trackerPrefs, sort: "best" };
  // Version 3 made "keep running in the tray" the default; an "off" saved before that was only the old default.
  if (version < 3) upgraded.closeToTray = true;
  return upgraded;
}

const bytesPerKilobyte = 1024;
const policyKeys = ["downloadLimit", "uploadLimit", "maxActiveDownloads", "seedRatio"] as const;

function applyDownloadPolicy(settings: Settings): void {
  backend
    .setDownloadPolicy({
      downloadLimit: settings.downloadLimit * bytesPerKilobyte,
      uploadLimit: settings.uploadLimit * bytesPerKilobyte,
      maxActiveDownloads: settings.maxActiveDownloads,
      seedRatio: settings.seedRatio,
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
