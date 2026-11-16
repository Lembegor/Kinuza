import { useEffect, useRef, useState } from "react";
import { backend, type MediaTracks } from "../lib/backend";
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

export type SelectedSubtitle = { kind: "none" } | { kind: "internal"; index: number } | { kind: "external" };

const installPollMs = 300;
const installGiveUpMs = 3 * 60 * 1000;
const rapidSeekMs = 600;
const exactSeekDelayMs = 350;
const restartLimit = 1;
const pictureSettleMs = 60;
const seekGiveUpMs = 5000;
const pictureCheckMs = 2500;

function pictureShown(): boolean {
  return document.documentElement.classList.contains("is-mpv-picture");
}

function showPicture(shown: boolean): void {
  document.documentElement.classList.toggle("is-mpv-picture", shown);
}

function where(url: string | null): string {
  if (!url) return "-";
  const found = /\/(?:stream|voice)\/([0-9a-f]{8})[0-9a-f]*\/(\d+)/i.exec(url);
  return found ? `${found[1]}/${found[2]}` : "other";
}

export class MpvVideo {
  handlers: Partial<MediaHandlers> = {};
  onTracksChanged: (() => void) | null = null;
  onFileLoaded: (() => void) | null = null;
  bufferedRanges: { start: number; end: number }[] = [];
  trackList: MpvTrack[] = [];
  chapterList: MpvChapter[] = [];

  private time = 0;
  private timeAt = 0;
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
  private seekTarget: number | null = null;
  private lastSeekAt = 0;
  private exactSeek: ReturnType<typeof setTimeout> | undefined;
  private seekGiveUp: ReturnType<typeof setTimeout> | undefined;
  private url: string | null = null;
  private restarts = 0;
  private outputReady = false;
  private frameShown = false;
  private pictureTimer: ReturnType<typeof setTimeout> | undefined;
  private pictureState = "";
  private stuckSince = 0;
  private checking = false;

  get currentTime(): number {
    return this.seekTarget ?? this.time;
  }

  set currentTime(seconds: number) {
    const now = performance.now();
    const rapid = now - this.lastSeekAt < rapidSeekMs;
    this.lastSeekAt = now;
    this.seekTarget = seconds;
    clearTimeout(this.exactSeek);
    clearTimeout(this.seekGiveUp);
    this.seekGiveUp = setTimeout(() => {
      if (this.exactSeek === undefined) this.seekTarget = null;
    }, seekGiveUpMs);
    void mpv.command("seek", seconds, rapid ? "absolute+keyframes" : "absolute+exact").catch(() => undefined);
    if (!rapid) return;
    this.exactSeek = setTimeout(() => {
      this.exactSeek = undefined;
      if (this.seekTarget !== null) void mpv.command("seek", this.seekTarget, "absolute+exact").catch(() => undefined);
    }, exactSeekDelayMs);
  }

  get duration(): number {
    return this.length;
  }

  get preciseTime(): number {
    if (this.seekTarget !== null) return this.seekTarget;
    if (this.pausedNow || this.waiting || this.seekingNow || !this.timeAt) return this.time;
    return this.time + Math.min(0.5, (performance.now() - this.timeAt) / 1000) * this.rateNow;
  }

  get paused(): boolean {
    return this.pausedNow;
  }

  get volume(): number {
    return this.volumeNow;
  }

  set volume(value: number) {
    this.volumeNow = value;
    void mpv.set("volume", Math.round(value * 100)).catch(() => undefined);
  }

  get muted(): boolean {
    return this.mutedNow;
  }

  set muted(value: boolean) {
    this.mutedNow = value;
    void mpv.set("mute", value).catch(() => undefined);
  }

  get playbackRate(): number {
    return this.rateNow;
  }

  set playbackRate(value: number) {
    this.rateNow = value;
    void mpv.set("speed", value).catch(() => undefined);
  }

  get videoWidth(): number {
    return this.width;
  }

  get videoHeight(): number {
    return this.height;
  }

  play(): Promise<void> {
    this.pausedNow = false;
    void mpv.set("pause", false).catch(() => undefined);
    return Promise.resolve();
  }

  pause(): void {
    this.pausedNow = true;
    void mpv.set("pause", true).catch(() => undefined);
  }

  prime(volume: number, muted: boolean, rate: number): void {
    this.volumeNow = volume;
    this.mutedNow = muted;
    this.rateNow = rate;
  }

  async load(url: string, start: number, startPaused = false, reason = "open"): Promise<void> {
    void backend.appLog(`player: mpv loads ${where(url)} at ${Math.round(start)}s paused=${startPaused} reason=${reason}`);
    this.url = url;
    this.time = start;
    this.length = Number.NaN;
    this.loaded = false;
    this.metadataSent = false;
    this.waiting = true;
    this.seekTarget = null;
    clearTimeout(this.exactSeek);
    this.bufferedRanges = [];
    this.trackList = [];
    this.chapterList = [];
    this.frameShown = false;
    this.refreshPicture();
    await mpv.set("volume", Math.round(this.volumeNow * 100));
    await mpv.set("mute", this.mutedNow);
    await mpv.set("speed", this.rateNow);
    await mpv.set("sid", "no");
    await mpv.set("secondary-sid", "no").catch(() => undefined);
    await mpv.set("start", start > 0 ? String(start) : "none");
    await mpv.set("pause", startPaused);
    this.pausedNow = startPaused;
    await mpv.command("loadfile", url, "replace");
  }

  stop(): void {
    this.url = null;
    clearTimeout(this.exactSeek);
    void mpv.command("stop").catch(() => undefined);
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
        externalFile: track.external ? (track["external-filename"] ?? "outside") : undefined,
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

  selectedSubtitle(): SelectedSubtitle {
    const selected = this.trackList.find((track) => track.type === "sub" && track.selected);
    if (!selected) return { kind: "none" };
    if (selected.external) return { kind: "external" };
    const index = this.trackList.filter((track) => track.type === "sub" && !track.external).indexOf(selected);
    return index >= 0 ? { kind: "internal", index } : { kind: "none" };
  }

  private restart(): boolean {
    if (!this.url || this.restarts >= restartLimit) return false;
    this.restarts += 1;
    const position = this.currentTime;
    report("player", "journal.mpv.restarted");
    void this.load(this.url, position, false, "mpv went away").catch(() => this.handlers.onError?.());
    return true;
  }

  private notePicture(shown: boolean): void {
    const state = shown ? "shown" : `hidden width=${this.width} output=${this.outputReady} frame=${this.frameShown}`;
    if (state === this.pictureState) return;
    this.pictureState = state;
    if (this.url) void backend.appLog(`player: picture ${state} at ${Math.round(this.time)}s`);
  }

  private refreshPicture(): void {
    clearTimeout(this.pictureTimer);
    if (!(this.width > 0 && this.outputReady && this.frameShown)) {
      showPicture(false);
      this.notePicture(false);
      return;
    }
    this.pictureTimer = setTimeout(() => {
      const shown = this.width > 0 && this.outputReady && this.frameShown;
      showPicture(shown);
      this.notePicture(shown);
    }, pictureSettleMs);
  }

  private placementNoted = "";

  private notePlacement(): void {
    const root = document.documentElement.classList;
    const placement = root.contains("is-player-inline") ? "inline" : root.contains("is-player-docked") ? "docked" : "full";
    const slot = placement === "inline" ? document.querySelector(".stage__slot") : null;
    const covered = slot !== null && getComputedStyle(slot).backgroundColor !== "rgba(0, 0, 0, 0)";
    const state = `${placement}${covered ? " covered" : ""}`;
    if (state === this.placementNoted) return;
    this.placementNoted = state;
    if (covered) void backend.appLog(`player: the ${placement} slot paints over the picture (stage playing=${document.querySelector(".stage.is-playing") !== null})`);
  }

  checkPicture(): void {
    const playing = this.url !== null && this.loaded && !this.pausedNow && !this.waiting;
    if (playing && pictureShown()) this.notePlacement();
    if (!playing || pictureShown()) {
      this.stuckSince = 0;
      return;
    }
    const now = performance.now();
    if (this.stuckSince === 0) {
      this.stuckSince = now;
      return;
    }
    if (now - this.stuckSince < pictureCheckMs || this.checking) return;
    this.checking = true;
    void mpv
      .stats(["estimated-vf-fps", "width", "height", "frame-drop-count"])
      .then((stats) => {
        const fps = Number(stats["estimated-vf-fps"]);
        const width = Number(stats.width);
        if (!(fps > 0) || !(width > 0) || pictureShown() || this.pausedNow) return;
        void backend.appLog(
          `player: picture was hidden while mpv showed ${fps.toFixed(1)} fps (width=${this.width} output=${this.outputReady} frame=${this.frameShown}), showing it`,
        );
        this.width = width;
        this.height = Number(stats.height) || this.height;
        this.outputReady = true;
        this.frameShown = true;
        this.refreshPicture();
      })
      .catch(() => undefined)
      .finally(() => {
        this.checking = false;
        this.stuckSince = 0;
      });
  }

  handle(event: MpvEvent): void {
    if (event.event === "playback-restart") {
      if (!this.frameShown) void backend.appLog(`player: mpv shows the first frame at ${Math.round(this.time)}s`);
      this.frameShown = true;
      this.refreshPicture();
      return;
    }
    if (event.event === "file-loaded") {
      void backend.appLog(`player: mpv opened ${where(this.url)}`);
      this.loaded = true;
      this.announceMetadata();
      this.onTracksChanged?.();
      this.onFileLoaded?.();
      this.updateWaiting();
      return;
    }
    if (event.event === "end-file") {
      if (event.reason === "error") this.handlers.onError?.();
      return;
    }
    if (event.event === "shutdown") {
      void backend.appLog(`player: mpv connection closed at ${Math.round(this.time)}s, ${this.url ? "restarting" : "idle"}`);
      this.outputReady = false;
      this.frameShown = false;
      this.refreshPicture();
      if (this.url && !this.restart()) this.handlers.onError?.();
      return;
    }
    if (event.event !== "property-change") return;
    const data = event.data;
    switch (event.name) {
      case "time-pos":
        if (typeof data === "number") {
          this.time = data;
          this.timeAt = performance.now();
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
        if (was && !this.seekingNow) {
          if (this.exactSeek === undefined) this.seekTarget = null;
          this.handlers.onSeeked?.();
        }
        break;
      }
      case "vo-configured":
        this.outputReady = data === true;
        this.refreshPicture();
        break;
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
        this.refreshPicture();
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

export function useMpvVideo(enabled: boolean): { video: MpvVideo; tracks: MediaTracks | null; generation: number } {
  const video = useRef(new MpvVideo()).current;
  const [tracks, setTracks] = useState<MediaTracks | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    video.onTracksChanged = () => setTracks(video.tracks());
    video.onFileLoaded = () => setGeneration((value) => value + 1);
    let stop: (() => void) | null = null;
    let cancelled = false;
    void mpv.onEvent((event) => video.handle(event)).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    document.documentElement.classList.add("is-mpv");
    void mpv.surface(true).catch(() => undefined);
    const pictureTimer = setInterval(() => video.checkPicture(), 1000);
    return () => {
      cancelled = true;
      clearInterval(pictureTimer);
      stop?.();
      video.onTracksChanged = null;
      video.onFileLoaded = null;
      video.stop();
      document.documentElement.classList.remove("is-mpv");
      showPicture(false);
      void mpv.surface(false).catch(() => undefined);
    };
  }, [enabled, video]);

  return { video, tracks, generation };
}

export type MpvMode = "checking" | "installing" | "ready" | "unavailable";

let fallenBack = false;
const fallbackListeners = new Set<() => void>();

export function switchToBuiltInPlayer(): void {
  fallenBack = true;
  for (const listener of fallbackListeners) listener();
}

export function useMpvMode(): { mode: MpvMode; progress: number; fallBack: () => void } {
  const [mode, setMode] = useState<MpvMode>(mpv.supported && !fallenBack ? "checking" : "unavailable");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const listener = () => setMode("unavailable");
    fallbackListeners.add(listener);
    return () => {
      fallbackListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!mpv.supported || fallenBack) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const status = await mpv.status();
        if (status.installed) {
          if (!cancelled && !fallenBack) setMode("ready");
          return;
        }
        if (!cancelled) setMode("installing");
        timer = setInterval(() => {
          void mpv.status().then((current) => {
            if (current.totalBytes > 0) setProgress(Math.min(1, current.downloadedBytes / current.totalBytes));
          });
        }, installPollMs);
        giveUp = setTimeout(() => {
          report("player", "journal.mpv.install", "timeout");
          switchToBuiltInPlayer();
        }, installGiveUpMs);
        await mpv.install();
        if (!cancelled && !fallenBack) setMode("ready");
      } catch (error) {
        report("player", "journal.mpv.install", error);
        if (!cancelled) setMode("unavailable");
      } finally {
        clearInterval(timer);
        clearTimeout(giveUp);
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(giveUp);
    };
  }, []);

  return { mode, progress, fallBack: switchToBuiltInPlayer };
}
