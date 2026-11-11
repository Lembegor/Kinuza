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
 * A stretch starts where playback is, not at a round minute: after a seek to 15:34 a stretch from
 * 15:00 would first download half a minute of film nobody watches before reaching a line that
 * is said now.
 */
const stretchSeconds = 80;
/** A stretch starts this much before the moment playback is at, for a line already being said. */
const leadSeconds = 3;
/** The next stretch is fetched when playback gets this close to the end of the current one. */
const fetchAheadSeconds = 25;
/** The next stretch starts this much before the end of the current one, so no line falls between. */
const overlapSeconds = 5;
/** Two copies of one line closer than this, or overlapping, are the same line. */
const sameLineGapSeconds = 0.3;
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
    /**
     * Cues by text. Stretches overlap, so a line near a border arrives twice, and not always with
     * the same times: the stretch that starts in the middle of it gives it a start cut to its own.
     */
    const loaded = new Map<string, Cue[]>();
    const keep = (cue: Cue) => {
      const same = loaded.get(cue.text);
      const copy = same?.find((known) => known.start <= cue.end + sameLineGapSeconds && cue.start <= known.end + sameLineGapSeconds);
      if (!copy) {
        loaded.set(cue.text, [...(same ?? []), { ...cue }]);
        return;
      }
      copy.start = Math.min(copy.start, cue.start);
      copy.end = Math.max(copy.end, cue.end);
    };
    /** Stretches asked for, read or being read; one that playback has left is dropped while it is read. */
    const stretches: { from: number; to: number; abort: AbortController; done: boolean }[] = [];
    const drop = (stretch: (typeof stretches)[number]) => {
      const index = stretches.indexOf(stretch);
      if (index >= 0) stretches.splice(index, 1);
    };
    const covering = (time: number) => stretches.find((stretch) => stretch.from <= time && time < stretch.to);

    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    // Lines arrive in bursts; the list shown is refreshed a few times a second at most.
    const publish = () => {
      if (publishTimer !== undefined) return;
      publishTimer = setTimeout(() => {
        publishTimer = undefined;
        if (!cancelled) setCues([...loaded.values()].flat().map((cue) => ({ ...cue })).sort((a, b) => a.start - b.start));
      }, publishDelayMs);
    };

    const load = async (from: number) => {
      const filmSeconds = clock().duration;
      if (!Number.isFinite(filmSeconds) || filmSeconds <= 0 || from >= filmSeconds) return;
      const stretch = { from, to: Math.min(filmSeconds, from + stretchSeconds), abort: new AbortController(), done: false };
      stretches.push(stretch);
      try {
        const url = await subtitleWindowUrl(source.infoHash, source.fileIndex, track, from, stretch.to - from, filmSeconds);
        const response = await fetch(url, { signal: stretch.abort.signal });
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
              const shifted = { ...cue, start: cue.start + from, end: cue.end + from };
              keep(shifted);
              lastStart = Math.max(lastStart, shifted.start);
            }
            pending = pending.slice(lastBreak);
            publish();
          }
          if (done) break;
        }
        stretch.done = true;
        // Some files keep their subtitles apart from the video and hand over everything at once;
        // what that covers needs no request of its own.
        stretch.to = Math.max(stretch.to, lastStart);
      } catch (error) {
        if (!stretch.abort.signal.aborted) report("player", "journal.subtitles.read", error);
        // Another try the next time playback is here.
        drop(stretch);
      }
    };

    const check = () => {
      const { time, duration } = clock();
      // After a seek a stretch being read elsewhere is of no use, and reading on would download
      // film nobody watches.
      for (const stretch of [...stretches]) {
        if (!stretch.done && (time < stretch.from - leadSeconds || time >= stretch.to)) {
          stretch.abort.abort();
          drop(stretch);
        }
      }
      const current = covering(time);
      if (!current) {
        void load(Math.max(0, time - leadSeconds));
      } else if (current.to - time < fetchAheadSeconds && current.to < duration && !covering(current.to)) {
        void load(Math.max(0, current.to - overlapSeconds));
      }
    };
    check();
    const timer = setInterval(check, checkIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
      clearTimeout(publishTimer);
      for (const stretch of stretches) stretch.abort.abort();
    };
  }, [sourceKey, track]); // eslint-disable-line react-hooks/exhaustive-deps

  return cues;
}
