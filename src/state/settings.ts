import { create } from "zustand";
import { backend } from "../lib/backend";
import { setApiKeyOverride } from "../lib/tmdb";

const storeName = "settings";

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
};

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
      const stored: Partial<Settings> = text ? JSON.parse(text) : {};
      set({ ...defaults, ...stored, loaded: true });
    } catch (error) {
      console.error("settings: load failed", error);
      set({ loaded: true });
    }
    setApiKeyOverride(get().tmdbKey);
  },

  patch(change) {
    set(change);
    if ("tmdbKey" in change) setApiKeyOverride(get().tmdbKey);
    const { loaded: _loaded, load: _load, patch: _patch, ...settings } = get();
    backend
      .storeSet(storeName, JSON.stringify(settings))
      .catch((error) => console.error("settings: save failed", error));
  },
}));
