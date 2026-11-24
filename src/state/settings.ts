import { create } from "zustand";
import { backend } from "../lib/backend";
import { isLinux } from "../lib/platform";
import { t } from "../lib/i18n";
import { report } from "../lib/journal";
import type { AppLanguage } from "../lib/languages";
import { setApiKeyOverride, setCatalogLanguage } from "../lib/tmdb";
import { useUi } from "./ui";

const storeName = "settings";
const currentVersion = 4;
const fallbackCatalogLanguage = "en";

export type CreditsSort = "rating" | "popular" | "newest" | "oldest";
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
export type AnimeUpscale = "off" | "normal" | "max";
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
  playerPlacement: "page" | "window";
  autoPick: boolean;
  stillWatching: boolean;
  soundSegments: boolean;
  smoothMotion: boolean;
  preferredQuality: number;
  handleLinks: boolean;
  linksPrompted: boolean;
  trackerPrefs: TrackerPrefs;
  creditsSort: CreditsSort;
  language: AppLanguage | "";
  audioLanguage: string;
  subtitleLanguage: string;
  lastVoice: VoiceChoice | null;
  lastSubtitles: SubtitleChoice | null;
  downloadLimit: number;
  uploadLimit: number;
  maxActiveDownloads: number;
  seedRatio: number;
  uploadByDefault: boolean;
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
  animeUpscale: AnimeUpscale;
  autoSimplify: boolean;
  spoilerDescriptions: SpoilerMode;
  spoilerStills: boolean;
  gridDensity: GridDensity;
  accent: string;
  homeOrder: string[];
  homeHidden: string[];
  homeFreshTab: string;
  homePopularTab: string;
  continueHidden: Record<string, number>;
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
  playerPlacement: "page",
  autoPick: true,
  stillWatching: false,
  soundSegments: true,
  smoothMotion: false,
  preferredQuality: 0,
  handleLinks: false,
  linksPrompted: false,
  trackerPrefs: { resolutions: [], voices: [], videoOnly: true, sort: "best" },
  creditsSort: "rating",
  language: "",
  audioLanguage: "",
  subtitleLanguage: "",
  lastVoice: null,
  lastSubtitles: null,
  downloadLimit: 0,
  uploadLimit: 0,
  maxActiveDownloads: 0,
  seedRatio: 0,
  uploadByDefault: true,
  cacheLimitGb: 10,
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
  animeUpscale: "off",
  autoSimplify: true,
  spoilerDescriptions: "blur",
  spoilerStills: true,
  gridDensity: "normal",
  accent: "",
  homeOrder: [],
  homeHidden: [],
  homeFreshTab: "",
  homePopularTab: "",
  continueHidden: {},
  version: currentVersion,
};

function upgrade(stored: Partial<Settings>): Partial<Settings> {
  const version = stored.version ?? 1;
  if (version >= currentVersion) return stored;
  const upgraded: Partial<Settings> = { ...stored, version: currentVersion };
  if (version < 2 && stored.trackerPrefs?.sort === "seeds") upgraded.trackerPrefs = { ...stored.trackerPrefs, sort: "best" };
  if (version < 3) upgraded.closeToTray = !isLinux;
  if (version < 4) upgraded.spoilerStills = true;
  if (version < 4 && stored.cacheLimitGb === 20) upgraded.cacheLimitGb = 10;
  return upgraded;
}

const bytesPerKilobyte = 1024;
const policyKeys = ["downloadLimit", "uploadLimit", "maxActiveDownloads", "seedRatio", "cacheLimitGb", "uploadByDefault"] as const;

function applyDownloadPolicy(settings: Settings): void {
  backend
    .setDownloadPolicy({
      downloadLimit: settings.downloadLimit * bytesPerKilobyte,
      uploadLimit: settings.uploadLimit * bytesPerKilobyte,
      maxActiveDownloads: settings.maxActiveDownloads,
      seedRatio: settings.seedRatio,
      cacheLimitGb: settings.cacheLimitGb,
      uploadOffByDefault: !settings.uploadByDefault,
    })
    .catch((error) => report("downloads", "journal.settings.policy", error));
}

export interface VoiceChoice {
  language: string;
  author: string;
  kind: string;
  original: boolean;
}

export interface SubtitleChoice {
  language: string;
  signs: boolean;
}

interface SettingsState extends Settings {
  loaded: boolean;
  load: (attempt?: number) => Promise<void>;
  patch: (change: Partial<Settings>) => void;
}

export const machineKeys = [
  "downloadDir",
  "downloadLimit",
  "uploadLimit",
  "maxActiveDownloads",
  "seedRatio",
  "uploadByDefault",
  "cacheLimitGb",
  "handleLinks",
  "linksPrompted",
  "closeToTray",
  "autoUpdate",
  "autoDeleteWatched",
  "notifyDownloads",
  "tmdbKey",
] as const satisfies readonly (keyof Settings)[];

const freshProfileSkips = ["continueHidden", "homeOrder", "homeHidden", "lastVoice", "lastSubtitles"] as const;

let earlyChanges: Partial<Settings> = {};
let inMainProfile = true;
let savingBlocked = false;
let saveFailureShown = false;
let waitingForStore = false;
const storeBusyRetryMs = 3000;
const storeBusyAttempts = 40;

function storeBusy(error: unknown): boolean {
  return String(error).includes("store_busy");
}

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

function pick(source: Partial<Settings>, keys: readonly (keyof Settings)[]): Partial<Settings> {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]])) as Partial<Settings>;
}

function parseSettings(text: string | undefined): Partial<Settings> | null {
  if (text === undefined) return null;
  const parsed: unknown = JSON.parse(text);
  return upgrade(typeof parsed === "object" && parsed !== null ? (parsed as Partial<Settings>) : {});
}

let machineWrites: Promise<void> = Promise.resolve();

function persistMachine(settings: Settings): void {
  const shared = pick(settings, machineKeys);
  machineWrites = machineWrites
    .then(async () => {
      const document = await backend.storeGet(storeName, true);
      const main = parseSettings(document?.text) ?? {};
      await backend.storeSet(storeName, JSON.stringify({ ...main, ...shared }), false, true);
    })
    .catch((error) => report("settings", "journal.settings.save", error));
}

async function readMainSettings(): Promise<Partial<Settings> | null> {
  const book = await backend.profilesList().catch(() => null);
  inMainProfile = !book || book.active === "main";
  if (inMainProfile) return null;
  const document = await backend.storeGet(storeName, true);
  return parseSettings(document?.text) ?? {};
}

function currentSettings(state: SettingsState): Settings {
  const { loaded: _loaded, load: _load, patch: _patch, ...settings } = state;
  return settings;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...defaults,
  loaded: false,

  async load(attempt = 0) {
    try {
      const main = await readMainSettings();
      const document = await backend.storeGet(storeName);
      const own = parseSettings(document?.text);
      const start = own ?? (main ? Object.fromEntries(Object.entries(main).filter(([key]) => !(freshProfileSkips as readonly string[]).includes(key))) : {});
      const stored: Partial<Settings> = main ? { ...start, ...pick(main, machineKeys) } : start;
      const recovering = waitingForStore;
      waitingForStore = false;
      savingBlocked = false;
      set({ ...defaults, ...stored, ...earlyChanges, loaded: true });
      if (Object.keys(earlyChanges).length > 0 || (own === null && main !== null)) persist(currentSettings(get()));
      if (recovering) void backend.appLog("settings: read after the store was busy");
    } catch (error) {
      savingBlocked = true;
      if (storeBusy(error) && attempt < storeBusyAttempts) {
        if (!waitingForStore) report("settings", "journal.settings.load", error);
        waitingForStore = true;
        set({ ...earlyChanges, loaded: true });
        setTimeout(() => void get().load(attempt + 1), storeBusyRetryMs);
        return;
      }
      waitingForStore = false;
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
    if (!get().loaded || waitingForStore) {
      earlyChanges = { ...earlyChanges, ...change };
      return;
    }
    if (policyKeys.some((key) => key in change)) applyDownloadPolicy(get());
    savingBlocked = false;
    persist(currentSettings(get()));
    if (!inMainProfile && machineKeys.some((key) => key in change)) persistMachine(currentSettings(get()));
  },
}));
