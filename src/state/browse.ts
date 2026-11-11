import { create } from "zustand";

interface BrowseState {
  search: string;
  remember: (search: string) => void;
}

export const useBrowse = create<BrowseState>((set) => ({
  search: "",
  remember: (search) => set({ search }),
}));
