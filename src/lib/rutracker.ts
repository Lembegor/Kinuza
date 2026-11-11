import { isDesktop } from "./backend";

export interface RutrackerItem {
  id: string;
  title: string;
  size: string;
  seeds: number;
  pageUrl: string;
}

/** Frame size of a release's video in pixels. */
export interface VideoSize {
  width: number;
  height: number;
}

/**
 * Error codes the backend rejects with. The forum is loaded in a hidden native window;
 * "cancelled" means the user closed it while it was shown for sign-in or a Cloudflare check.
 */
export const rutrackerErrors = {
  authRequired: "auth_required",
  cancelled: "cancelled",
  timeout: "timeout",
  /** The page with the results could not be read. */
  parseFailed: "tracker_parse_failed",
  /** The forum changed the layout of its pages, so the results could not be read. */
  markupChanged: "tracker_markup_changed",
  /** The forum opened something other than the search page; that page's title follows after a colon. */
  unexpectedPage: "tracker_unexpected_page",
} as const;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isDesktop) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }
  const { mockInvoke } = await import("./backend.mock");
  return mockInvoke(command, args) as Promise<T>;
}

export const rutracker = {
  search: (query: string) => call<RutrackerItem[]>("rutracker_search", { query }),
  /**
   * Shows the forum's own login page in a native window and resolves once the user has
   * signed in there. Rejects with "cancelled" if the window is closed first.
   */
  login: () => call<void>("rutracker_login_window"),
  /** `quiet`: asked in the background; the forum's window is never shown, the request fails instead. */
  getMagnet: (id: string, quiet = false) => call<string>("rutracker_magnet", { id, quiet }),
  /** Frame sizes read from the releases' own pages; releases whose page does not state one are left out. */
  videoSizes: (ids: string[]) => call<Record<string, VideoSize>>("rutracker_video_sizes", { ids }),
};
