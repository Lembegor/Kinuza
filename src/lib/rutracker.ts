import { backend, isDesktop, type TorrentPreview } from "./backend";

export interface RutrackerItem {
  id: string;
  title: string;
  size: string;
  seeds: number;
  pageUrl: string;
}

export interface VideoSize {
  width: number;
  height: number;
}

export const rutrackerErrors = {
  authRequired: "auth_required",
  cancelled: "cancelled",
  timeout: "timeout",
  parseFailed: "tracker_parse_failed",
  markupChanged: "tracker_markup_changed",
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
  search: (query: string, quiet = false, page = 0) => call<RutrackerItem[]>("rutracker_search", { query, quiet, page }),
  pageSize: 50,
  login: () => call<void>("rutracker_login_window"),
  maybeSignedIn: () => call<boolean | null>("rutracker_maybe_signed_in").catch(() => null),
  showWindow: () => call<void>("rutracker_show_window").catch(() => undefined),
  account: () => call<{ signedIn: boolean } | null>("rutracker_account"),
  signOut: () => call<void>("rutracker_sign_out"),
  getMagnet: (id: string, quiet = false) => call<string>("rutracker_magnet", { id, quiet }),
  inspectRelease: async (id: string, quiet = false): Promise<TorrentPreview> => {
    try {
      return await call<TorrentPreview>("rutracker_torrent_inspect", { id, quiet });
    } catch (error) {
      if (String(error).includes(rutrackerErrors.authRequired) || String(error).includes(rutrackerErrors.cancelled)) throw error;
      return backend.inspectLink(await rutracker.getMagnet(id, quiet));
    }
  },
  videoSizes: (ids: string[]) => call<Record<string, VideoSize>>("rutracker_video_sizes", { ids }),
};
