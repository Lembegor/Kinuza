// Transient UI state: toasts, the add-source dialog, the confirm dialog and the player session.

import { create } from "zustand";
import type { SeasonInfo } from "../lib/tmdb";
import type { TitleRef } from "./library";

const toastLifetimeMs = 5000;

export type ToastKind = "info" | "success" | "error";

/** A button on a toast, e.g. to take back what the toast reports. */
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

/** What a new torrent should be attached to. Without a target the dialog asks for the title. */
export interface AddSourceTarget {
  title: TitleRef;
  /** Title in the original language; free copies are looked up by it. */
  originalTitle?: string;
  /** Two-letter code of the language the title was made in. */
  originalLanguage?: string;
  seasons: SeasonInfo[];
  defaultSeason: number;
}

export interface AddSourceRequest {
  target: AddSourceTarget | null;
  /** Offered first when the dialog has to ask which title the torrent belongs to. */
  suggested?: AddSourceTarget | null;
  magnet?: string;
  filePath?: string;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  /** Optional checkbox, e.g. "also delete files". */
  optionLabel?: string;
  danger?: boolean;
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
  /** The title open on screen; a pasted magnet or a dropped .torrent attaches to it. */
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

let nextToastId = 1;

export const useUi = create<UiState>((set, get) => ({
  toasts: [],
  addSource: null,
  confirm: null,
  player: null,
  pageTarget: null,
  setPageTarget: (target) => set({ pageTarget: target }),

  toast(text, kind = "info", action) {
    const id = nextToastId++;
    set((state) => ({ toasts: [...state.toasts, { id, kind, text, action }] }));
    setTimeout(() => get().dismissToast(id), toastLifetimeMs);
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),

  openAddSource: (request) => set({ addSource: request }),
  closeAddSource: () => set({ addSource: null }),

  askConfirm: (request) => set({ confirm: request }),
  closeConfirm: () => set({ confirm: null }),

  play: (session) => set({ player: session }),
  closePlayer: () => set({ player: null }),
}));
