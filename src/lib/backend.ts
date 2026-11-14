import { t, type MessageKey } from "./i18n";
import { isDesktop } from "./platform";

export { isDesktop, isLinux, isWindows } from "./platform";

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

export type TorrentState = "initializing" | "live" | "paused" | "error" | "parked" | "queued";

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
  uploadEnabled: boolean;
  queueOrder?: number;
  focused?: boolean;
}

export interface AppInfo {
  version: string;
  streamBaseUrl: string;
  defaultDownloadDir: string;
  externalPlayer: string | null;
  sessionReset: boolean;
  listenPort: number;
  updatedFrom: string | null;
}

export interface LaunchRequest {
  kind: "magnet" | "file";
  value: string;
}

export interface AssociationStatus {
  enabled: boolean;
  overriddenByWindows: boolean;
}

export interface ImdbRating {
  rating: number;
  votes: number;
}

export interface FileDialog {
  title: string;
  filterName: string;
  extensions: string[];
}

export interface StoredDocument {
  text: string;
  recovered: boolean;
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

export async function thumbnailUrl(infoHash: string, fileIndex: number, at: number, width: number): Promise<string> {
  const info = await getAppInfo();
  return `${info.streamBaseUrl}/thumbnail/${infoHash}/${fileIndex}?at=${Math.max(0, Math.round(at))}&width=${Math.round(width)}`;
}

export async function convertedStreamUrl(infoHash: string, fileIndex: number, audio: number, start: number): Promise<string> {
  const info = await getAppInfo();
  return `${info.streamBaseUrl}/video/${infoHash}/${fileIndex}?audio=${audio}&start=${start.toFixed(3)}`;
}

export async function audioStreamUrl(infoHash: string, fileIndex: number, track: number, start: number): Promise<string> {
  const info = await getAppInfo();
  return `${info.streamBaseUrl}/audio/${infoHash}/${fileIndex}?track=${track}&start=${start.toFixed(3)}`;
}

export interface FfmpegStatus {
  installed: boolean;
  installing: boolean;
  downloadedBytes: number;
  totalBytes: number;
}

export async function subtitleWindowUrl(
  infoHash: string,
  fileIndex: number,
  track: number,
  start: number,
  duration: number,
  filmSeconds: number,
): Promise<string> {
  const info = await getAppInfo();
  const query = `track=${track}&start=${start}&duration=${duration}&length=${Math.round(filmSeconds)}`;
  return `${info.streamBaseUrl}/subtitles/${infoHash}/${fileIndex}?${query}`;
}

export interface SubtitleTrackInfo {
  index: number;
  language: string;
  codec: string;
  title: string;
  isDefault: boolean;
  isForced: boolean;
  isText: boolean;
}

export interface OnlineSubtitle {
  fileId: number;
  language: string;
  release: string;
  downloads: number;
  hearingImpaired: boolean;
  machineTranslated: boolean;
  hashMatch: boolean;
}

export interface ReportRequest {
  description: string;
  sender: string;
  journal: string;
  settings: string;
  includeLog: boolean;
}

export interface OnlineSubtitleQuery {
  tmdbId: number;
  season: number | null;
  episode: number | null;
  languages: string[];
  moviehash?: string | null;
}

export interface Chapter {
  start: number;
  end: number;
  title: string;
}

export interface MediaTracks {
  audio: AudioTrackInfo[];
  subtitles: SubtitleTrackInfo[];
  chapters: Chapter[];
  duration: number;
  videoCodec: string;
}

export interface DownloadPolicy {
  downloadLimit: number;
  uploadLimit: number;
  maxActiveDownloads: number;
  seedRatio: number;
  cacheLimitGb: number;
  uploadOffByDefault: boolean;
}

export interface StorageInfo {
  freeBytes: number;
  totalBytes: number;
  cacheBytes: number;
}

export interface StorageDisk {
  path: string;
  freeBytes: number;
  totalBytes: number;
}

export interface CacheEntry {
  infoHash: string;
  name: string;
  bytes: number;
  lastPlayed: number;
  inUse: boolean;
}

export type StoragePartId = "library" | "catalog" | "ffmpeg" | "imdb" | "fingerprints" | "logs" | "mpv" | "webCache" | "webData";

export interface StoragePart {
  id: StoragePartId;
  bytes: number;
  clearable: boolean;
  later: boolean;
}

export interface TitleLinks {
  mal: number | null;
  anilist: number | null;
  ru: string | null;
  uk: string | null;
}

export interface ShikimoriAnime {
  id: number;
  russian: string;
  description: string;
  names: string[];
  genres: { name: string; russian: string }[];
}

export interface ShikimoriFound {
  id: number;
  russian: string;
  name: string;
  kind: string;
  year: number | null;
}

export interface MalLink {
  mal: number;
  kind: "movie" | "tv";
  tmdbId: number;
}

export interface ShikimoriName {
  id: number;
  russian: string;
}

export interface StorageReport {
  downloadsDisk: StorageDisk | null;
  dataDisk: StorageDisk | null;
  cache: CacheEntry[];
  parts: StoragePart[];
  webCachePending: boolean;
}

export interface AudioTrackInfo {
  index: number;
  language: string;
  codec: string;
  channels: string;
  title: string;
  isDefault: boolean;
  isOriginal: boolean;
  externalFile?: string;
}

export interface PrintTarget {
  infoHash: string;
  fileIndex: number;
}

export interface SoundSegments {
  intro: { start: number; end: number } | null;
  credits: { start: number; end: number; sceneAfter: boolean } | null;
}

export const backend = {
  ffmpegStatus: () => call<FfmpegStatus>("ffmpeg_status"),
  ffmpegInstall: () => call<void>("ffmpeg_install"),
  mediaTracks: (infoHash: string, fileIndex: number) => call<MediaTracks>("media_tracks", { infoHash, fileIndex }),
  inspectLink: (link: string) => call<TorrentPreview>("torrent_inspect", { link }),
  inspectFile: (path: string) => call<TorrentPreview>("torrent_inspect", { path }),
  addTorrent: (infoHash: string, files: number[], downloadDir: string | null) =>
    call<void>("torrent_add", { infoHash, files, downloadDir }),
  listTorrents: () => call<TorrentView[]>("torrent_list"),
  pause: (infoHash: string) => call<void>("torrent_pause", { infoHash }),
  setUpload: (infoHash: string, enabled: boolean) => call<void>("torrent_set_upload", { infoHash, enabled }),
  resume: (infoHash: string) => call<void>("torrent_resume", { infoHash }),
  excludeFiles: (infoHash: string, files: number[]) => call<void>("torrent_exclude_files", { infoHash, files }),
  focusTorrent: (infoHash: string) => call<void>("torrent_focus", { infoHash }),
  reorderTorrents: (infoHashes: string[]) => call<void>("torrent_reorder", { infoHashes }),
  remove: (infoHash: string, deleteFiles: boolean) =>
    call<void>("torrent_delete", { infoHash, deleteFiles }),
  selectFiles: (infoHash: string, files: number[], downloadDir: string | null) =>
    call<void>("torrent_select_files", { infoHash, files, downloadDir }),
  holdOnline: (infoHash: string) => call<void>("torrent_hold", { infoHash }),
  releaseOnline: (infoHash: string) => call<void>("torrent_release", { infoHash }),
  fileLocation: (infoHash: string, fileIndex: number) =>
    call<string>("file_location", { infoHash, fileIndex }),
  openExternal: (infoHash: string, fileIndex: number) =>
    call<string>("open_external", { infoHash, fileIndex }),
  pickFile: (dialog: FileDialog) => call<string | null>("file_pick", { dialog }),
  pickSaveTarget: (dialog: FileDialog & { defaultName: string }) => call<string | null>("file_save_target", { dialog }),
  readFileBytes: (path: string) => call<ArrayBuffer>("read_file_bytes", { path }),
  findOnlineSubtitles: (apiKey: string, query: OnlineSubtitleQuery) =>
    call<OnlineSubtitle[]>("online_subtitles_search", { apiKey, query }),
  buildReport: (request: ReportRequest) => call<string>("report_build", { request }),
  sendReport: (token: string, chatId: string, request: ReportRequest) => call<void>("report_send", { token, chatId, request }),
  subtitleFileHash: (infoHash: string, fileIndex: number) => call<string>("subtitle_file_hash", { infoHash, fileIndex }),
  audioPrint: (target: PrintTarget, part: "head" | "tail", seconds: number) => call<boolean>("audio_print", { target, part, seconds }),
  audioPrintCancel: () => call<void>("audio_print_cancel"),
  audioOffset: (reference: PrintTarget, other: PrintTarget) =>
    call<{ seconds: number; matchedSeconds: number } | null>("audio_offset", { reference, other }),
  audioSegments: (target: PrintTarget, duration: number, neighbours: PrintTarget[]) =>
    call<SoundSegments>("audio_segments", { target, duration, neighbours }),
  torrentFileMap: (infoHash: string, fileIndex: number, buckets: number) =>
    call<number[]>("torrent_file_map", { infoHash, fileIndex, buckets }),
  async saveScreenshot(png: Uint8Array, label: string): Promise<string> {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<string>("save_screenshot", png, { headers: { "x-kinuza-label": encodeURIComponent(label) } });
  },
  mediaSessionStart: (now: { title: string; subtitle: string; coverUrl: string | null; duration: number }) =>
    call<void>("media_session_start", { now }),
  mediaSessionState: (playing: boolean, position: number) => call<void>("media_session_state", { playing, position }),
  mediaSessionStop: () => call<void>("media_session_stop"),
  downloadOnlineSubtitle: (apiKey: string, fileId: number) =>
    call<ArrayBuffer>("online_subtitles_download", { apiKey, fileId }),
  configureTray: (enabled: boolean, labels: { open: string; quit: string; tooltip: string }) =>
    call<void>("tray_configure", { enabled, labels }),
  writeTextFile: (path: string, contents: string) => call<void>("write_text_file", { path, contents }),
  setDownloadPolicy: (policy: DownloadPolicy) => call<void>("torrent_set_policy", { policy }),
  storageInfo: (downloadDir: string | null) => call<StorageInfo>("storage_info", { downloadDir }),
  logWrite: (level: "info" | "warn" | "error", message: string) => call<void>("log_write", { level, message }),
  openLogs: () => call<void>("logs_open"),
  clearStreamCache: () => call<number>("stream_cache_clear"),
  storageReport: (downloadDir: string | null) => call<StorageReport>("storage_report", { downloadDir }),
  wikidataLinks: (kind: "movie" | "tv", tmdbId: number) => call<TitleLinks | null>("wikidata_links", { kind, tmdbId }),
  shikimoriAnime: (id: number) => call<ShikimoriAnime | null>("shikimori_anime", { id }),
  shikimoriNames: (ids: number[]) => call<ShikimoriName[] | null>("shikimori_names", { ids }),
  shikimoriSearch: (query: string) => call<ShikimoriFound[] | null>("shikimori_search", { query }),
  wikidataByMal: (ids: number[]) => call<MalLink[] | null>("wikidata_by_mal", { ids }),
  catalogLookup: (keys: { kind: string; id: number }[]) => call<string[] | null>("catalog_lookup", { keys }),
  catalogSearch: (query: string) => call<string[] | null>("catalog_search", { query }),
  clearStoragePart: (id: StoragePartId) => call<number>("storage_clear_part", { id }),
  dropCached: (infoHash: string) => call<number>("storage_drop_cached", { infoHash }),
  freeDownload: (infoHash: string) => call<number>("storage_free_download", { infoHash }),
  takeLaunchRequest: () => call<LaunchRequest | null>("take_launch_request"),
  associationStatus: () => call<AssociationStatus>("associations_status"),
  setAssociations: (enabled: boolean) => call<AssociationStatus>("associations_set", { enabled }),
  openDefaultAppsSettings: () => call<void>("open_default_apps_settings"),
  imdbRating: (imdbId: string) => call<ImdbRating | null>("imdb_rating", { imdbId }),
  storeGet: (name: string) => call<StoredDocument | null>("store_get", { name }),
  storeSet: (name: string, value: string, allowShrink = false) => call<void>("store_set", { name, value, allowShrink }),
  appLog: (message: string) => (isDesktop ? call<void>("app_log", { message }).catch(() => undefined) : Promise.resolve()),
  warm: (infoHash: string, fileIndex: number, full: boolean) => call<void>("torrent_warm", { infoHash, fileIndex, full }),
  stopEngine: () => call<void>("engine_stop"),
  activityAppend: (events: object[]) => call<number>("activity_append", { events }),
  activityRead: (since?: number) => call<object[]>("activity_read", { since: since ?? null }),
};

export async function onLaunchRequest(handler: (request: LaunchRequest) => void): Promise<() => void> {
  if (!isDesktop) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<LaunchRequest>(launchEvent, (event) => handler(event.payload));
}

const errorMessages: Record<string, MessageKey> = {
  associations_failed: "errors.associationsFailed",
  settings_unavailable: "errors.settingsUnavailable",
  metadata_timeout: "errors.metadataTimeout",
  torrent_not_inspected: "errors.torrentNotInspected",
  torrent_not_found: "errors.torrentNotFound",
  last_file: "errors.lastFile",
  torrent_file_unreadable: "errors.torrentFileUnreadable",
  no_external_player: "errors.noExternalPlayer",
  file_too_large: "errors.fileTooLarge",
  file_unreadable: "errors.fileUnreadable",
  file_not_chosen: "errors.fileUnreadable",
  store_unwritable: "library.saveFailed",
  bad_info_hash: "errors.badInfoHash",
  bad_link: "errors.badLink",
  auth_required: "errors.trackerAuth",
  magnet_not_found: "errors.releaseUnavailable",
  torrent_file_unavailable: "errors.releaseUnavailable",
  gateway_login: "errors.serverLogin",
  gateway_challenge: "errors.serverLogin",
  gateway_down: "errors.serverDown",
  gateway_timeout: "errors.serverDown",
  timeout: "errors.trackerTimeout",
  cancelled: "errors.trackerCancelled",
  library_unreadable: "errors.libraryUnreadable",
  disk_full: "errors.diskFull",
  tracker_busy: "errors.trackerBusy",
  report_failed: "report.failed",
  report_unconfigured: "report.unconfigured",
  report_empty: "report.empty",
  storage_in_use: "storage.inUse",
  storage_clear_failed: "storage.failed",
};

export function describeError(error: unknown): string {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (code.startsWith("mpv_failed:")) return t("errors.mpvFailed", { detail: code.slice("mpv_failed:".length) });
  if (code === "mpv_timeout" || code === "mpv_gone" || code === "mpv_start_failed") return t("errors.mpvUnavailable");
  const known = errorMessages[code];
  if (known) return t(known);
  return code ? t("errors.code", { code }) : t("errors.unknown");
}
