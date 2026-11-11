import { isDesktop } from "./backend";

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
  supported: isDesktop && navigator.userAgent.includes("Windows"),
  status: () => invoke<MpvStatus>("mpv_status"),
  install: () => invoke<void>("mpv_install"),
  warm: () => invoke<void>("mpv_warm"),
  command: (...command: unknown[]) => invoke<void>("mpv_command", { command }),
  set: (name: string, value: unknown) => invoke<void>("mpv_set", { name, value }),
  addSubtitleText: (text: string, title: string) => invoke<void>("mpv_add_subtitle_text", { text, title }),
  async onEvent(handler: (event: MpvEvent) => void): Promise<() => void> {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<MpvEvent>("mpv-event", (message) => handler(message.payload));
  },
};
