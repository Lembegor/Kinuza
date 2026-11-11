// Where the catalog page was left, so that coming back to it from the side menu restores the filters.

import { create } from "zustand";

interface BrowseState {
  /** Query string of the catalog page without the leading "?"; empty for the default filters. */
  search: string;
  remember: (search: string) => void;
}

export const useBrowse = create<BrowseState>((set) => ({
  search: "",
  remember: (search) => set({ search }),
}));
