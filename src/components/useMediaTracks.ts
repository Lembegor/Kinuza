// What a video file holds besides the picture: its audio tracks and embedded subtitles.
// Reading them needs FFmpeg, which is downloaded the first time a film calls for it.

import { useCallback, useEffect, useState } from "react";
import { backend, subtitleWindowUrl, type MediaTracks } from "../lib/backend";
import { report } from "../lib/journal";
import { parseSubtitles, type Cue } from "../lib/subtitles";

const installPollMs = 400;
/** How many times, and how far apart, a file's tracks are asked for before giving up. */
const readAttempts = 12;
const retryDelayMs = 4000;

export interface MediaTracksState {
  /** Null until known: FFmpeg is absent, or the file is still being read. */
  tracks: MediaTracks | null;
  /** FFmpeg is on this computer. Null while that is being checked. */
  ffmpegInstalled: boolean | null;
  installing: boolean;
  /** Download progress while installing, 0..1. */
  installProgress: number;
  /** Size of the FFmpeg download in bytes. */
  installBytes: number;
  installFailed: boolean;
  install: () => void;
}

export function useMediaTracks(source: { infoHash: string; fileIndex: number } | null): MediaTracksState {
  const [tracks, setTracks] = useState<MediaTracks | null>(null);
  const [ffmpegInstalled, setFfmpegInstalled] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installProgress, setInstallProgress] = useState(0);
  const [installBytes, setInstallBytes] = useState(0);
  const [installFailed, setInstallFailed] = useState(false);

  const sourceKey = source ? `${source.infoHash}:${source.fileIndex}` : "";

  useEffect(() => {
    setTracks(null);
    if (!source) return;
    let cancelled = false;
    void backend
      .ffmpegStatus()
      .then(async (status) => {
        if (cancelled) return;
        setFfmpegInstalled(status.installed);
        setInstallBytes(status.totalBytes);
        if (!status.installed) return;
        // A torrent that has only just been added, or whose first pieces have not arrived, cannot
        // be read yet; the tracks are asked for again until they come.
        for (let attempt = 0; attempt < readAttempts && !cancelled; attempt++) {
          try {
            const found = await backend.mediaTracks(source.infoHash, source.fileIndex);
            if (!cancelled) setTracks(found);
            return;
          } catch (error) {
            console.error("tracks: could not read the file yet", error);
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
        }
      })
      .catch((error) => report("player", "journal.ffmpeg.status", error));
    return () => {
      cancelled = true;
    };
    // `ffmpegInstalled` is listed so the tracks are read as soon as an installation finishes.
  }, [sourceKey, ffmpegInstalled]); // eslint-disable-line react-hooks/exhaustive-deps

  const install = useCallback(() => {
    setInstalling(true);
    setInstallFailed(false);
    setInstallProgress(0);
    const poll = setInterval(() => {
      void backend.ffmpegStatus().then((status) => {
        if (status.totalBytes > 0) setInstallProgress(Math.min(1, status.downloadedBytes / status.totalBytes));
      });
    }, installPollMs);
    void backend
      .ffmpegInstall()
      .then(() => setFfmpegInstalled(true))
      .catch((error) => {
        report("player", "journal.ffmpeg.install", error);
        setInstallFailed(true);
      })
      .finally(() => {
        clearInterval(poll);
        setInstalling(false);
      });
  }, []);

  return { tracks, ffmpegInstalled, installing, installProgress, installBytes, installFailed, install };
}

/**
 * Subtitles are read one stretch of the film at a time: in most files they are scattered among
 * the video, so reading them means reading (and, when watching online, downloading) the video too.
 */
const windowSeconds = 60;
/** The next stretch is fetched when playback gets this close to the end of the current one. */
const fetchAheadSeconds = 25;
/** Stretches overlap by this much, so a line near the border is not lost to an imprecise cut. */
const overlapSeconds = 20;
const checkIntervalMs = 2000;
const publishDelayMs = 250;

/**
 * Cues of embedded subtitle track `track` around the current playback position, growing as the
 * film plays or is sought. Empty while `track` is null.
 */
export function useEmbeddedSubtitles(
  /** Where in the film playback is and how long the film runs, in seconds. */
  clock: () => { time: number; duration: number },
  source: { infoHash: string; fileIndex: number } | null,
  track: number | null,
): Cue[] {
  const [cues, setCues] = useState<Cue[]>([]);
  const sourceKey = source ? `${source.infoHash}:${source.fileIndex}` : "";

  useEffect(() => {
    setCues([]);
    if (track === null || !source) return;
    let cancelled = false;
    /** Cues by start time and text: a line on the border of two stretches arrives with both. */
    const loaded = new Map<string, Cue>();
    const requested = new Set<number>();

    /** Requests in flight by stretch, so one that playback has left can be dropped. */
    const reading = new Map<number, AbortController>();
    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    // Lines arrive in bursts; the list shown is refreshed a few times a second at most.
    const publish = () => {
      if (publishTimer !== undefined) return;
      publishTimer = setTimeout(() => {
        publishTimer = undefined;
        if (!cancelled) setCues([...loaded.values()].sort((a, b) => a.start - b.start));
      }, publishDelayMs);
    };

    const load = async (windowIndex: number) => {
      const filmSeconds = clock().duration;
      if (windowIndex < 0 || requested.has(windowIndex) || !Number.isFinite(filmSeconds) || filmSeconds <= 0) return;
      requested.add(windowIndex);
      const start = windowIndex * windowSeconds;
      const abort = new AbortController();
      reading.set(windowIndex, abort);
      try {
        const url = await subtitleWindowUrl(
          source.infoHash,
          source.fileIndex,
          track,
          start,
          windowSeconds + overlapSeconds,
          filmSeconds,
        );
        const response = await fetch(url, { signal: abort.signal });
        if (!response.ok || !response.body) throw new Error(`subtitles_${response.status}`);

        // The lines come as they are read from the file (while watching online, as it downloads),
        // so each complete one is taken at once instead of waiting for the end of the stretch.
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let pending = "";
        let lastStart = 0;
        for (;;) {
          const { done, value } = await reader.read();
          pending += value ?? "";
          const lastBreak = done ? pending.length : pending.lastIndexOf("\n\n");
          if (lastBreak > 0) {
            // Times in the response count from the start of the stretch.
            for (const cue of parseSubtitles(pending.slice(0, lastBreak))) {
              const shifted = { ...cue, start: cue.start + start, end: cue.end + start };
              loaded.set(`${shifted.start.toFixed(1)}|${shifted.text}`, shifted);
              lastStart = Math.max(lastStart, shifted.start);
            }
            pending = pending.slice(lastBreak);
            publish();
          }
          if (done) break;
        }
        // Some files keep their subtitles apart from the video and hand over everything at once;
        // the stretches that covers need no request of their own.
        for (let covered = windowIndex + 1; (covered + 1) * windowSeconds <= lastStart; covered++) requested.add(covered);
      } catch (error) {
        if (!abort.signal.aborted) report("player", "journal.subtitles.read", error);
        // Allows another try the next time playback is here.
        requested.delete(windowIndex);
      } finally {
        reading.delete(windowIndex);
      }
    };

    const check = () => {
      const { time } = clock();
      const current = Math.floor(time / windowSeconds);
      // After a seek the old stretch is of no use, and reading it would download what nobody watches.
      for (const [windowIndex, abort] of reading) {
        if (windowIndex < current || windowIndex > current + 1) abort.abort();
      }
      void load(current);
      if (time - current * windowSeconds > windowSeconds - fetchAheadSeconds) void load(current + 1);
    };
    check();
    const timer = setInterval(check, checkIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(publishTimer);
      for (const abort of reading.values()) abort.abort();
    };
  }, [sourceKey, track]); // eslint-disable-line react-hooks/exhaustive-deps

  return cues;
}
