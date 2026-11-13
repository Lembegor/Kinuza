import { create } from "zustand";
import type { SeasonInfo } from "../lib/tmdb";
import type { TitleRef } from "./library";
import type { Coverage, EpisodeLayout } from "../lib/episodeLayout";

export type ToastKind = "info" | "success" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  action?: ToastAction;
}

export interface AddSourceTarget {
  title: TitleRef;
  originalTitle?: string;
  originalLanguage?: string;
  seasons: SeasonInfo[];
  defaultSeason: number;
  pinnedSeason?: number;
  layout?: EpisodeLayout | null;
  coverage?: Coverage | null;
  recut?: boolean;
  defaultEpisode?: number;
}

export interface AddSourceRequest {
  target: AddSourceTarget | null;
  suggested?: AddSourceTarget | null;
  magnet?: string;
  filePath?: string;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  optionLabel?: string;
  optionChecked?: boolean;
  danger?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
  onConfirm: (optionChecked: boolean) => void;
}

export interface PlayerSession {
  title: TitleRef;
  unitKey: string;
  season?: number;
  episode?: number;
  episodeName?: string;
  preferredSourceId?: string;
}

interface UiState {
  toasts: Toast[];
  addSource: AddSourceRequest | null;
  confirm: ConfirmRequest | null;
  player: PlayerSession | null;
  pageTarget: AddSourceTarget | null;
  setPageTarget: (target: AddSourceTarget | null) => void;
  toast: (text: string, kind?: ToastKind, action?: ToastAction) => void;
  dismissToast: (id: number) => void;
  openAddSource: (request: AddSourceRequest) => void;
  closeAddSource: () => void;
  askConfirm: (request: ConfirmRequest) => void;
  closeConfirm: () => void;
  play: (session: PlayerSession) => void;
  closePlayer: () => void;
}

export const homeRefreshEvent = "kinuza:home-refresh";

let nextToastId = 1;
const maxToasts = 2;

export const useUi = create<UiState>((set) => ({
  toasts: [],
  addSource: null,
  confirm: null,
  player: null,
  pageTarget: null,
  setPageTarget: (target) => set({ pageTarget: target }),

  toast(text, kind = "info", action) {
    const id = nextToastId++;
    set((state) => ({ toasts: [...state.toasts.filter((toast) => toast.kind === "error"), { id, kind, text, action }].slice(-maxToasts) }));
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  openAddSource: (request) => set({ addSource: request }),
  closeAddSource: () => set({ addSource: null }),

  askConfirm: (request) => set({ confirm: request }),
  closeConfirm: () => set({ confirm: null }),

  play: (session) => set({ player: session }),
  closePlayer: () => set({ player: null }),
}));
