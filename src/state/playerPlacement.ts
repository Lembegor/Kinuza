import { create } from "zustand";

export type Placement = "inline" | "docked" | "full";

interface PlacementState {
  slot: HTMLElement | null;
  slotTitle: string | null;
  expanded: boolean;
  away: boolean;
  focusRequest: number;
  requestFocus: () => void;
  setSlot: (slot: HTMLElement | null, titleKey: string | null) => void;
  setExpanded: (expanded: boolean) => void;
  setAway: (away: boolean) => void;
}

export const usePlayerPlacement = create<PlacementState>((set, get) => ({
  slot: null,
  slotTitle: null,
  expanded: false,
  away: false,
  focusRequest: 0,
  requestFocus: () => set({ focusRequest: get().focusRequest + 1, expanded: false }),
  setSlot: (slot, titleKey) => {
    if (get().slot === slot && get().slotTitle === titleKey) return;
    set({ slot, slotTitle: titleKey, away: false });
  },
  setExpanded: (expanded) => {
    if (get().expanded !== expanded) set({ expanded });
  },
  setAway: (away) => {
    if (get().away !== away) set({ away });
  },
}));

export function placementFor(state: Pick<PlacementState, "slot" | "slotTitle" | "expanded" | "away">, titleKey: string, onPage: boolean): Placement {
  if (!onPage || state.expanded) return "full";
  return state.slot && state.slotTitle === titleKey && !state.away ? "inline" : "docked";
}
