import { isDesktop } from "./backend";

export interface RutrackerItem {
  id: string;
  title: string;
  size: string;
  seeds: number;
  pageUrl: string;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isDesktop) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }
  throw new Error("RuTracker search requires desktop environment");
}

export const rutracker = {
  search: (query: string) => call<RutrackerItem[]>("rutracker_search", { query }),
  login: (user: string, pass: string) => call<void>("rutracker_login", { user, pass }),
  getMagnet: (id: string) => call<string>("rutracker_magnet", { id }),
};
