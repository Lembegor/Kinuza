import type { AudioMode } from "../state/settings";
import { isMac, isWindows } from "./platform";

export interface MpvStatus {
  installed: boolean;
  installing: boolean;
  downloadedBytes: number;
  totalBytes: number;
}

export interface MpvTrack {
  id: number;
  type: "video" | "audio" | "sub";
  lang?: string;
  title?: string;
  codec?: string;
  default?: boolean;
  forced?: boolean;
  external?: boolean;
  "external-filename"?: string;
  selected?: boolean;
  "demux-channel-count"?: number;
  "demux-channels"?: string;
}

export interface MpvChapter {
  title?: string;
  time: number;
}

export interface MpvEvent {
  event: string;
  name?: string;
  data?: unknown;
  reason?: string;
  file_error?: string;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(command, args);
}

export const mpv = {
  supported: isWindows || isMac,
  // macOS draws through libmpv's render API with audio-timed video, where interpolation does nothing.
  smoothMotion: isWindows,
  status: () => invoke<MpvStatus>("mpv_status"),
  surface: (shown: boolean) => invoke<void>("mpv_surface", { shown }),
  install: () => invoke<void>("mpv_install"),
  warm: () => invoke<void>("mpv_warm"),
  quit: () => invoke<void>("mpv_quit"),
  command: (...command: unknown[]) => invoke<void>("mpv_command", { command }),
  set: (name: string, value: unknown) => invoke<void>("mpv_set", { name, value }),
  place: (x: number, y: number, width: number, height: number) => invoke<void>("mpv_place", { x, y, width, height }),
  addSubtitleText: (text: string, title: string) => invoke<void>("mpv_add_subtitle_text", { text, title }),
  audioFilter: (mode: AudioMode) => invoke<void>("mpv_audio_filter", { mode }),
  stats: () => invoke<Record<string, unknown>>("mpv_stats"),
  screenshot: (label: string) => invoke<string>("mpv_screenshot", { label }),
  async onEvent(handler: (event: MpvEvent) => void): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<MpvEvent>("mpv-event", (message) => handler(message.payload));
  },
};
