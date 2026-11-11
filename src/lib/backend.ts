// Typed bridge to the Rust backend. In a plain browser (UI preview) a mock stands in for it.

import { t, type MessageKey } from "./i18n";

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

/** "parked": watched online earlier; nothing of it is on disk until it is played again. */
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

export interface ImdbRating {
  /** 1.0 to 10.0. */
  rating: number;
  votes: number;
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

/**
 * Address of the film converted on the fly to a picture and sound the player can decode,
 * beginning at `start` seconds, with audio track `audio`. To seek, ask for another address.
 */
export async function convertedStreamUrl(infoHash: string, fileIndex: number, audio: number, start: number): Promise<string> {
  const info = await getAppInfo();
  return `${info.streamBaseUrl}/video/${infoHash}/${fileIndex}?audio=${audio}&start=${start.toFixed(3)}`;
}

/** Address of one audio track converted to a format the player can decode, starting at `start` seconds. */
export async function audioStreamUrl(infoHash: string, fileIndex: number, track: number, start: number): Promise<string> {
  const info = await getAppInfo();
  return `${info.streamBaseUrl}/audio/${infoHash}/${fileIndex}?track=${track}&start=${start.toFixed(3)}`;
}

export interface FfmpegStatus {
  installed: boolean;
  installing: boolean;
  downloadedBytes: number;
  /** Size of the download; an estimate until the download has started. */
  totalBytes: number;
}

/**
 * Address of a stretch of one embedded subtitle track as SRT text; its times count from `start`.
 * `filmSeconds` is the running time of the whole film: it tells the backend how much of the file the stretch is.
 */
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
  /** Position among the file's subtitle tracks, from zero. */
  index: number;
  language: string;
  codec: string;
  title: string;
  isDefault: boolean;
  /** Only signs and foreign-language lines, for viewers who follow the sound. */
  isForced: boolean;
  /** False for picture-based subtitles, which cannot be shown. */
  isText: boolean;
}

/** Subtitles someone uploaded to OpenSubtitles for a film or an episode. */
export interface OnlineSubtitle {
  fileId: number;
  /** Two-letter language code. */
  language: string;
  /** The release the subtitles were timed to, as the uploader named it. */
  release: string;
  downloads: number;
  hearingImpaired: boolean;
  machineTranslated: boolean;
}

export interface OnlineSubtitleQuery {
  /** Catalog id of the film, or of the series for an episode. */
  tmdbId: number;
  season: number | null;
  episode: number | null;
  /** Two-letter codes, most wanted first. */
  languages: string[];
}

/** A named stretch of the film marked in the file: "Opening", "Chapter 3", "End Credits". */
export interface Chapter {
  /** Seconds from the start of the film. */
  start: number;
  end: number;
  title: string;
}

export interface MediaTracks {
  audio: AudioTrackInfo[];
  subtitles: SubtitleTrackInfo[];
  chapters: Chapter[];
  /** Running time in seconds; 0 when the file does not state it. */
  duration: number;
  /** Codec of the picture, as FFmpeg names it: "h264", "hevc", "mpeg4". */
  videoCodec: string;
}

/** Limits in bytes per second (0: none), the queue size (0: all at once), the seeding ratio (0: no limit). */
export interface DownloadPolicy {
  downloadLimit: number;
  uploadLimit: number;
  maxActiveDownloads: number;
  seedRatio: number;
}

export interface StorageInfo {
  /** Free space on the disk that holds the download folder. */
  freeBytes: number;
  totalBytes: number;
}

export interface AudioTrackInfo {
  /** Position among the file's audio tracks, from zero. */
  index: number;
  /** ISO 639 code as the file states it ("rus", "eng"); empty when it does not. */
  language: string;
  codec: string;
  /** Channel layout: "stereo", "5.1(side)". */
  channels: string;
  title: string;
  isDefault: boolean;
  /** The file marks the track as the film's original language. */
  isOriginal: boolean;
}

export const backend = {
  /** Whether FFmpeg, which converts audio the player cannot decode, is on this computer. */
  ffmpegStatus: () => call<FfmpegStatus>("ffmpeg_status"),
  /** Downloads FFmpeg; resolves once it is ready. */
  ffmpegInstall: () => call<void>("ffmpeg_install"),
  /** Audio tracks and embedded subtitles of a torrent file; needs FFmpeg. */
  mediaTracks: (infoHash: string, fileIndex: number) => call<MediaTracks>("media_tracks", { infoHash, fileIndex }),
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
  /** Starts saving files to disk; a torrent that was only watched online becomes a download. */
  selectFiles: (infoHash: string, files: number[], downloadDir: string | null) =>
    call<void>("torrent_select_files", { infoHash, files, downloadDir }),
  /** Ends an online viewing: what was fetched for it is deleted. Does nothing for a download. */
  releaseOnline: (infoHash: string) => call<void>("torrent_release", { infoHash }),
  fileLocation: (infoHash: string, fileIndex: number) =>
    call<string>("file_location", { infoHash, fileIndex }),
  openExternal: (infoHash: string, fileIndex: number) =>
    call<string>("open_external", { infoHash, fileIndex }),
  readFileBytes: (path: string) => call<ArrayBuffer>("read_file_bytes", { path }),
  findOnlineSubtitles: (apiKey: string, query: OnlineSubtitleQuery) =>
    call<OnlineSubtitle[]>("online_subtitles_search", { apiKey, query }),
  /** The subtitle file's bytes, in whatever encoding it was uploaded in. */
  downloadOnlineSubtitle: (apiKey: string, fileId: number) =>
    call<ArrayBuffer>("online_subtitles_download", { apiKey, fileId }),
  /** Shows or removes the tray icon; `labels` are its menu texts in the interface language. */
  configureTray: (enabled: boolean, labels: { open: string; quit: string; tooltip: string }) =>
    call<void>("tray_configure", { enabled, labels }),
  /** Saves text to a file the user chose in a save dialog. */
  writeTextFile: (path: string, contents: string) => call<void>("write_text_file", { path, contents }),
  setDownloadPolicy: (policy: DownloadPolicy) => call<void>("torrent_set_policy", { policy }),
  storageInfo: (downloadDir: string | null) => call<StorageInfo>("storage_info", { downloadDir }),
  takeLaunchRequest: () => call<LaunchRequest | null>("take_launch_request"),
  associationStatus: () => call<AssociationStatus>("associations_status"),
  setAssociations: (enabled: boolean) => call<AssociationStatus>("associations_set", { enabled }),
  openDefaultAppsSettings: () => call<void>("open_default_apps_settings"),
  /** Rating of a title on IMDb by its id ("tt1375666"); null when IMDb has none or the ratings could not be fetched. */
  imdbRating: (imdbId: string) => call<ImdbRating | null>("imdb_rating", { imdbId }),
  storeGet: (name: string) => call<string | null>("store_get", { name }),
  storeSet: (name: string, value: string) => call<void>("store_set", { name, value }),
};

/** Subscribes to links forwarded by a second launch of the app. Returns an unsubscribe function. */
export async function onLaunchRequest(handler: (request: LaunchRequest) => void): Promise<() => void> {
  if (!isDesktop) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<LaunchRequest>(launchEvent, (event) => handler(event.payload));
}

/** Backend error codes and the messages that explain them. */
const errorMessages: Record<string, MessageKey> = {
  associations_failed: "errors.associationsFailed",
  settings_unavailable: "errors.settingsUnavailable",
  metadata_timeout: "errors.metadataTimeout",
  torrent_not_inspected: "errors.torrentNotInspected",
  torrent_not_found: "errors.torrentNotFound",
  torrent_file_unreadable: "errors.torrentFileUnreadable",
  no_external_player: "errors.noExternalPlayer",
  file_too_large: "errors.fileTooLarge",
  file_unreadable: "errors.fileUnreadable",
  bad_info_hash: "errors.badInfoHash",
  bad_link: "errors.badLink",
};

/** Turns a backend error code into text for the user. */
export function describeError(error: unknown): string {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const known = errorMessages[code];
  if (known) return t(known);
  return code ? t("errors.code", { code }) : t("errors.unknown");
}
