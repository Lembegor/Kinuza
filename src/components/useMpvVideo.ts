import { useEffect, useRef, useState } from "react";
import type { MediaTracks } from "../lib/backend";
import { report } from "../lib/journal";
import { mpv, type MpvChapter, type MpvEvent, type MpvTrack } from "../lib/mpv";

export interface MediaHandlers {
  onPlay: () => void;
  onPause: () => void;
  onWaiting: () => void;
  onPlaying: () => void;
  onLoadedMetadata: () => void;
  onDurationChange: () => void;
  onTimeUpdate: () => void;
  onProgress: () => void;
  onSeeked: () => void;
  onEnded: () => void;
  onError: () => void;
}

const installPollMs = 300;

export class MpvVideo {
  handlers: Partial<MediaHandlers> = {};
  onTracksChanged: (() => void) | null = null;
  bufferedRanges: { start: number; end: number }[] = [];
  trackList: MpvTrack[] = [];
  chapterList: MpvChapter[] = [];

  private time = 0;
  private length = Number.NaN;
  private pausedNow = true;
  private volumeNow = 1;
  private mutedNow = false;
  private rateNow = 1;
  private width = 0;
  private height = 0;
  private loaded = false;
  private metadataSent = false;
  private waitingForCache = false;
  private seekingNow = false;
  private waiting = true;

  get currentTime(): number {
    return this.time;
  }

  set currentTime(seconds: number) {
    this.time = seconds;
    void mpv.command("seek", seconds, "absolute+exact");
  }

  get duration(): number {
    return this.length;
  }

  get paused(): boolean {
    return this.pausedNow;
  }

  get volume(): number {
    return this.volumeNow;
  }

  set volume(value: number) {
    this.volumeNow = value;
    void mpv.set("volume", Math.round(value * 100));
  }

  get muted(): boolean {
    return this.mutedNow;
  }

  set muted(value: boolean) {
    this.mutedNow = value;
    void mpv.set("mute", value);
  }

  get playbackRate(): number {
    return this.rateNow;
  }

  set playbackRate(value: number) {
    this.rateNow = value;
    void mpv.set("speed", value);
  }

  get videoWidth(): number {
    return this.width;
  }

  get videoHeight(): number {
    return this.height;
  }

  play(): Promise<void> {
    this.pausedNow = false;
    void mpv.set("pause", false);
    return Promise.resolve();
  }

  pause(): void {
    this.pausedNow = true;
    void mpv.set("pause", true);
  }

  prime(volume: number, muted: boolean, rate: number): void {
    this.volumeNow = volume;
    this.mutedNow = muted;
    this.rateNow = rate;
  }

  async load(url: string, start: number): Promise<void> {
    this.time = start;
    this.length = Number.NaN;
    this.loaded = false;
    this.metadataSent = false;
    this.waiting = true;
    this.bufferedRanges = [];
    this.trackList = [];
    this.chapterList = [];
    await mpv.set("volume", Math.round(this.volumeNow * 100));
    await mpv.set("mute", this.mutedNow);
    await mpv.set("speed", this.rateNow);
    await mpv.set("start", start > 0 ? String(start) : "none");
    await mpv.set("pause", false);
    this.pausedNow = false;
    await mpv.command("loadfile", url, "replace");
  }

  stop(): void {
    void mpv.command("stop");
  }

  tracks(): MediaTracks | null {
    if (!this.loaded) return null;
    const audio = this.trackList.filter((track) => track.type === "audio");
    const subtitles = this.trackList.filter((track) => track.type === "sub" && !track.external);
    const video = this.trackList.find((track) => track.type === "video");
    const chapters = this.chapterList.map((chapter, index) => ({
      start: chapter.time,
      end: this.chapterList[index + 1]?.time ?? (Number.isFinite(this.length) ? this.length : chapter.time),
      title: chapter.title ?? "",
    }));
    return {
      audio: audio.map((track, index) => ({
        index,
        language: track.lang ?? "",
        codec: track.codec ?? "",
        channels: track["demux-channels"] ?? (track["demux-channel-count"] ? `${track["demux-channel-count"]}ch` : ""),
        title: track.title ?? "",
        isDefault: track.default ?? false,
        isOriginal: false,
      })),
      subtitles: subtitles.map((track, index) => ({
        index,
        language: track.lang ?? "",
        codec: track.codec ?? "",
        title: track.title ?? "",
        isDefault: track.default ?? false,
        isForced: track.forced ?? false,
        isText: true,
      })),
      chapters,
      duration: Number.isFinite(this.length) ? this.length : 0,
      videoCodec: video?.codec ?? "",
    };
  }

  audioId(index: number): number | null {
    return this.trackList.filter((track) => track.type === "audio")[index]?.id ?? null;
  }

  subtitleId(index: number): number | null {
    return this.trackList.filter((track) => track.type === "sub" && !track.external)[index]?.id ?? null;
  }

  handle(event: MpvEvent): void {
    if (event.event === "file-loaded") {
      this.loaded = true;
      this.announceMetadata();
      this.onTracksChanged?.();
      this.updateWaiting();
      return;
    }
    if (event.event === "end-file") {
      if (event.reason === "error") this.handlers.onError?.();
      return;
    }
    if (event.event === "shutdown") {
      if (this.loaded) this.handlers.onError?.();
      return;
    }
    if (event.event !== "property-change") return;
    const data = event.data;
    switch (event.name) {
      case "time-pos":
        if (typeof data === "number") {
          this.time = data;
          this.handlers.onTimeUpdate?.();
        }
        break;
      case "duration":
        if (typeof data === "number") {
          this.length = data;
          this.handlers.onDurationChange?.();
          this.announceMetadata();
        }
        break;
      case "pause":
        this.pausedNow = data === true;
        if (this.pausedNow) this.handlers.onPause?.();
        else this.handlers.onPlay?.();
        this.updateWaiting();
        break;
      case "paused-for-cache":
        this.waitingForCache = data === true;
        this.updateWaiting();
        break;
      case "seeking": {
        const was = this.seekingNow;
        this.seekingNow = data === true;
        this.updateWaiting();
        if (was && !this.seekingNow) this.handlers.onSeeked?.();
        break;
      }
      case "eof-reached":
        if (data === true && this.loaded) this.handlers.onEnded?.();
        break;
      case "demuxer-cache-state": {
        const ranges = (data as { "seekable-ranges"?: { start: number; end: number }[] } | null)?.["seekable-ranges"] ?? [];
        this.bufferedRanges = ranges.filter((range) => typeof range.start === "number" && typeof range.end === "number");
        this.handlers.onProgress?.();
        break;
      }
      case "track-list":
        this.trackList = Array.isArray(data) ? (data as MpvTrack[]) : [];
        this.onTracksChanged?.();
        break;
      case "chapter-list":
        this.chapterList = Array.isArray(data) ? (data as MpvChapter[]) : [];
        this.onTracksChanged?.();
        break;
      case "video-params": {
        const params = data as { dw?: number; dh?: number; w?: number; h?: number } | null;
        this.width = params?.dw ?? params?.w ?? 0;
        this.height = params?.dh ?? params?.h ?? 0;
        this.announceMetadata();
        break;
      }
    }
  }

  private announceMetadata(): void {
    if (this.metadataSent || !this.loaded || !Number.isFinite(this.length) || this.length <= 0) return;
    this.metadataSent = true;
    this.handlers.onLoadedMetadata?.();
  }

  private updateWaiting(): void {
    const waiting = !this.loaded || (!this.pausedNow && (this.waitingForCache || this.seekingNow));
    if (waiting === this.waiting) return;
    this.waiting = waiting;
    if (waiting) this.handlers.onWaiting?.();
    else this.handlers.onPlaying?.();
  }
}

export function useMpvVideo(enabled: boolean): { video: MpvVideo; tracks: MediaTracks | null } {
  const video = useRef(new MpvVideo()).current;
  const [tracks, setTracks] = useState<MediaTracks | null>(null);

  useEffect(() => {
    if (!enabled) return;
    video.onTracksChanged = () => setTracks(video.tracks());
    let stop: (() => void) | null = null;
    let cancelled = false;
    void mpv.onEvent((event) => video.handle(event)).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    document.documentElement.classList.add("is-mpv");
    return () => {
      cancelled = true;
      stop?.();
      video.onTracksChanged = null;
      video.stop();
      document.documentElement.classList.remove("is-mpv");
    };
  }, [enabled, video]);

  return { video, tracks };
}

export type MpvMode = "checking" | "installing" | "ready" | "unavailable";

export function useMpvMode(): { mode: MpvMode; progress: number } {
  const [mode, setMode] = useState<MpvMode>(mpv.supported ? "checking" : "unavailable");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!mpv.supported) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      try {
        const status = await mpv.status();
        if (status.installed) {
          if (!cancelled) setMode("ready");
          return;
        }
        if (!cancelled) setMode("installing");
        timer = setInterval(() => {
          void mpv.status().then((current) => {
            if (current.totalBytes > 0) setProgress(Math.min(1, current.downloadedBytes / current.totalBytes));
          });
        }, installPollMs);
        await mpv.install();
        if (!cancelled) setMode("ready");
      } catch (error) {
        report("player", "journal.mpv.install", error);
        if (!cancelled) setMode("unavailable");
      } finally {
        clearInterval(timer);
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { mode, progress };
}
