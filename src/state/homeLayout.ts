import type { MessageKey } from "../lib/i18n";
import { useMemo } from "react";
import { useSettings } from "./settings";

export type HomeBlockId = "pick" | "continue" | "month" | "forYou" | "week" | "fresh" | "similar" | "planned" | "daily" | "popular";

export interface HomeBlockInfo {
  id: HomeBlockId;
  nameKey: MessageKey;
  hintKey: MessageKey;
}

export const homeBlocks: HomeBlockInfo[] = [
  { id: "pick", nameKey: "home.block.pick", hintKey: "home.block.pick.hint" },
  { id: "continue", nameKey: "home.block.continue", hintKey: "home.block.continue.hint" },
  { id: "month", nameKey: "home.block.month", hintKey: "home.block.month.hint" },
  { id: "forYou", nameKey: "home.block.forYou", hintKey: "home.block.forYou.hint" },
  { id: "week", nameKey: "home.block.week", hintKey: "home.block.week.hint" },
  { id: "fresh", nameKey: "home.block.fresh", hintKey: "home.block.fresh.hint" },
  { id: "similar", nameKey: "home.block.similar", hintKey: "home.block.similar.hint" },
  { id: "planned", nameKey: "home.block.planned", hintKey: "home.block.planned.hint" },
  { id: "daily", nameKey: "home.block.daily", hintKey: "home.block.daily.hint" },
  { id: "popular", nameKey: "home.block.popular", hintKey: "home.block.popular.hint" },
];

const defaultOrder = homeBlocks.map((block) => block.id);
const known = new Set<string>(defaultOrder);

export function orderedBlocks(order: string[]): HomeBlockId[] {
  const kept = order.filter((id): id is HomeBlockId => known.has(id));
  const unique = [...new Set(kept)];
  for (const id of defaultOrder) if (!unique.includes(id)) unique.splice(Math.min(defaultOrder.indexOf(id), unique.length), 0, id);
  return unique;
}

export function useHomeLayout(): { order: HomeBlockId[]; hidden: Set<HomeBlockId> } {
  const order = useSettings((state) => state.homeOrder);
  const hidden = useSettings((state) => state.homeHidden);
  return useMemo(() => ({ order: orderedBlocks(order), hidden: new Set(hidden.filter((id): id is HomeBlockId => known.has(id))) }), [order, hidden]);
}

export function setBlockHidden(id: HomeBlockId, hide: boolean): void {
  const { homeHidden, patch } = useSettings.getState();
  const next = hide ? [...new Set([...homeHidden, id])] : homeHidden.filter((item) => item !== id);
  patch({ homeHidden: next });
}

export function moveBlock(id: HomeBlockId, toIndex: number): void {
  const { homeOrder, patch } = useSettings.getState();
  const order = orderedBlocks(homeOrder).filter((item) => item !== id);
  order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, id);
  patch({ homeOrder: order });
}

export function resetHomeLayout(): void {
  useSettings.getState().patch({ homeOrder: [], homeHidden: [] });
}

export function isDefaultLayout(order: string[], hidden: string[]): boolean {
  return hidden.length === 0 && orderedBlocks(order).every((id, index) => id === defaultOrder[index]);
}
