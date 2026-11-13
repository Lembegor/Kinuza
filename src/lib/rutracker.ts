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

export type TrackerRoute = "own" | "server";

export type ServerProblem = "login" | "down" | "failed";

export const rutrackerErrors = {
  authRequired: "auth_required",
  cancelled: "cancelled",
  timeout: "timeout",
  parseFailed: "tracker_parse_failed",
  markupChanged: "tracker_markup_changed",
  unexpectedPage: "tracker_unexpected_page",
  serverPrefix: "gateway_",
} as const;

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isDesktop) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }
  const { mockInvoke } = await import("./backend.mock");
  return mockInvoke(command, args) as Promise<T>;
}

export function isServerError(error: unknown): boolean {
  return String(error).startsWith(rutrackerErrors.serverPrefix);
}

export function serverProblemOf(error: unknown): ServerProblem {
  const code = String(error);
  if (code === "gateway_login" || code === "gateway_challenge") return "login";
  if (code === "gateway_down") return "down";
  return "failed";
}

type ServerKind = "interactive" | "secondary" | "background";

const maybeSignedIn = () => call<boolean | null>("rutracker_maybe_signed_in").catch(() => null);

let ownSessionGone = false;

export async function trackerRoute(): Promise<TrackerRoute> {
  if (ownSessionGone) return "server";
  return (await maybeSignedIn()) === true ? "own" : "server";
}

function ownSessionLost(error: unknown): boolean {
  const lost = error === rutrackerErrors.authRequired || String(error).includes(rutrackerErrors.authRequired);
  if (lost) ownSessionGone = true;
  return lost;
}

const viaServer = {
  search: (query: string, page: number, kindName: ServerKind) =>
    call<RutrackerItem[]>("gateway_search", { query, page, kindName }),
  inspect: (id: string, maxAgeSeconds: number | null, kindName: ServerKind) =>
    call<TorrentPreview>("gateway_torrent_inspect", { id, maxAge: maxAgeSeconds, kindName }),
  videoSizes: (ids: string[], kindName: ServerKind) => call<Record<string, VideoSize>>("gateway_video_sizes", { ids, kindName }),
};

async function inspectOwn(id: string, quiet: boolean): Promise<TorrentPreview> {
  try {
    return await call<TorrentPreview>("rutracker_torrent_inspect", { id, quiet });
  } catch (error) {
    if (ownSessionLost(error) || String(error).includes(rutrackerErrors.cancelled)) throw error;
    return backend.inspectLink(await rutracker.getMagnet(id, quiet));
  }
}

export const rutracker = {
  search: async (query: string, quiet = false, page = 0, background = false): Promise<RutrackerItem[]> => {
    if ((await trackerRoute()) === "own") {
      try {
        return await call<RutrackerItem[]>("rutracker_search", { query, quiet, page });
      } catch (error) {
        if (!ownSessionLost(error)) throw error;
      }
    }
    return viaServer.search(query, page, background ? "background" : quiet ? "secondary" : "interactive");
  },
  pageSize: 50,
  login: async () => {
    await call<void>("rutracker_login_window");
    ownSessionGone = false;
  },
  maybeSignedIn,
  showWindow: () => call<void>("rutracker_show_window").catch(() => undefined),
  account: () => call<{ signedIn: boolean } | null>("rutracker_account"),
  serverStatus: () => call<{ state: string }>("gateway_status").catch(() => ({ state: "down" })),
  signOut: () => call<void>("rutracker_sign_out"),
  getMagnet: (id: string, quiet = false) => call<string>("rutracker_magnet", { id, quiet }),
  inspectRelease: async (id: string, quiet = false, background = false, freshWithinSeconds: number | null = null): Promise<TorrentPreview> => {
    if ((await trackerRoute()) === "own") {
      try {
        return await inspectOwn(id, quiet);
      } catch (error) {
        if (!ownSessionLost(error)) throw error;
      }
    }
    return viaServer.inspect(id, freshWithinSeconds, background ? "background" : "interactive");
  },
  videoSizes: async (ids: string[], background = false): Promise<Record<string, VideoSize>> => {
    if ((await trackerRoute()) === "own") {
      try {
        return await call<Record<string, VideoSize>>("rutracker_video_sizes", { ids });
      } catch (error) {
        if (!ownSessionLost(error)) throw error;
      }
    }
    return viaServer.videoSizes(ids, background ? "background" : "secondary");
  },
};
