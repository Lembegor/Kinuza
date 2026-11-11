// Typed bridge to the Rust backend. In a plain browser (UI preview) a mock stands in for it.

export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface TorrentFile {
  index: number;
  path: string;
  length: number;
  included: boolean;
  downloaded: number;
}

export interface TorrentPreview {
  infoHash: string;
  name: string;
  files: TorrentFile[];
  alreadyAdded: boolean;
}

export type TorrentState = "initializing" | "live" | "paused" | "error";

export interface TorrentView {
  infoHash: string;
  name: string;
  outputFolder: string;
  state: TorrentState;
  error: string | null;
  progressBytes: number;
  totalBytes: number;
  uploadedBytes: number;
  finished: boolean;
  downloadSpeed: number;
  uploadSpeed: number;
  peers: number;
  files: TorrentFile[];
}

export interface AppInfo {
  version: string;
  streamBaseUrl: string;
  defaultDownloadDir: string;
  externalPlayer: string | null;
}

/** A magnet link or .torrent file Windows handed to the app. */
export interface LaunchRequest {
  kind: "magnet" | "file";
  value: string;
}

export interface AssociationStatus {
  enabled: boolean;
  overriddenByWindows: boolean;
}

const launchEvent = "launch-request";

type Args = Record<string, unknown>;

async function call<T>(command: string, args?: Args): Promise<T> {
  if (isDesktop) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }
  const { mockInvoke } = await import("./backend.mock");
  return mockInvoke(command, args) as Promise<T>;
}

let appInfoPromise: Promise<AppInfo> | null = null;

export function getAppInfo(): Promise<AppInfo> {
  appInfoPromise ??= call<AppInfo>("app_info");
  return appInfoPromise;
}

export async function streamUrl(infoHash: string, fileIndex: number): Promise<string> {
  if (!isDesktop) return (await import("./backend.mock")).mockStreamUrl;
  const info = await getAppInfo();
  return `${info.streamBaseUrl}/stream/${infoHash}/${fileIndex}`;
}

export const backend = {
  /** Accepts a magnet link or the address of an Internet Archive torrent. */
  inspectLink: (link: string) => call<TorrentPreview>("torrent_inspect", { link }),
  inspectFile: (path: string) => call<TorrentPreview>("torrent_inspect", { path }),
  addTorrent: (infoHash: string, files: number[], downloadDir: string | null) =>
    call<void>("torrent_add", { infoHash, files, downloadDir }),
  listTorrents: () => call<TorrentView[]>("torrent_list"),
  pause: (infoHash: string) => call<void>("torrent_pause", { infoHash }),
  resume: (infoHash: string) => call<void>("torrent_resume", { infoHash }),
  remove: (infoHash: string, deleteFiles: boolean) =>
    call<void>("torrent_delete", { infoHash, deleteFiles }),
  selectFiles: (infoHash: string, files: number[]) =>
    call<void>("torrent_select_files", { infoHash, files }),
  fileLocation: (infoHash: string, fileIndex: number) =>
    call<string>("file_location", { infoHash, fileIndex }),
  openExternal: (infoHash: string, fileIndex: number) =>
    call<string>("open_external", { infoHash, fileIndex }),
  readFileBytes: (path: string) => call<ArrayBuffer>("read_file_bytes", { path }),
  takeLaunchRequest: () => call<LaunchRequest | null>("take_launch_request"),
  associationStatus: () => call<AssociationStatus>("associations_status"),
  setAssociations: (enabled: boolean) => call<AssociationStatus>("associations_set", { enabled }),
  openDefaultAppsSettings: () => call<void>("open_default_apps_settings"),
  storeGet: (name: string) => call<string | null>("store_get", { name }),
  storeSet: (name: string, value: string) => call<void>("store_set", { name, value }),
};

/** Subscribes to links forwarded by a second launch of the app. Returns an unsubscribe function. */
export async function onLaunchRequest(handler: (request: LaunchRequest) => void): Promise<() => void> {
  if (!isDesktop) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<LaunchRequest>(launchEvent, (event) => handler(event.payload));
}

const errorMessages: Record<string, string> = {
  associations_failed: "Не удалось изменить программу по умолчанию для торрентов.",
  settings_unavailable: "Не удалось открыть параметры Windows.",
  metadata_timeout:
    "Не удалось получить список файлов: у раздачи сейчас нет доступных участников. Попробуйте позже или другую ссылку.",
  torrent_not_inspected: "Сначала откройте торрент заново.",
  torrent_not_found: "Торрент не найден в загрузках.",
  torrent_file_unreadable: "Не удалось прочитать .torrent-файл.",
  no_external_player: "Не найден внешний плеер. Установите VLC или mpv.",
  file_too_large: "Файл слишком большой.",
  file_unreadable: "Не удалось прочитать файл.",
  bad_info_hash: "Некорректная ссылка на торрент.",
  bad_link: "Такая ссылка не поддерживается. Нужна magnet-ссылка.",
};

/** Turns a backend error code into text for the user. */
export function describeError(error: unknown): string {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return errorMessages[code] ?? (code ? `Ошибка: ${code}` : "Что-то пошло не так.");
}
