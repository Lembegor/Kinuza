import { useCallback, useEffect, useState } from "react";
import { backend, subtitleWindowUrl, type MediaTracks } from "../lib/backend";
import { report } from "../lib/journal";
import { parseSubtitles, type Cue } from "../lib/subtitles";

const installPollMs = 400;
const readAttempts = 12;
const retryDelayMs = 4000;

export interface MediaTracksState {
  tracks: MediaTracks | null;
  ffmpegInstalled: boolean | null;
  installing: boolean;
  installProgress: number;
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

const stretchSeconds = 80;
const leadSeconds = 3;
const fetchAheadSeconds = 25;
const overlapSeconds = 5;
const sameLineGapSeconds = 0.3;
const checkIntervalMs = 2000;
const publishDelayMs = 250;

export function useEmbeddedSubtitles(
  clock: () => { time: number; duration: number; busy?: boolean },
  source: { infoHash: string; fileIndex: number } | null,
  track: number | null,
): Cue[] {
  const [cues, setCues] = useState<Cue[]>([]);
  const sourceKey = source ? `${source.infoHash}:${source.fileIndex}` : "";

  useEffect(() => {
    setCues([]);
    if (track === null || !source) return;
    let cancelled = false;
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
    const stretches: { from: number; to: number; abort: AbortController; done: boolean }[] = [];
    const drop = (stretch: (typeof stretches)[number]) => {
      const index = stretches.indexOf(stretch);
      if (index >= 0) stretches.splice(index, 1);
    };
    const covering = (time: number) => stretches.find((stretch) => stretch.from <= time && time < stretch.to);

    let publishTimer: ReturnType<typeof setTimeout> | undefined;
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

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let pending = "";
        let lastStart = 0;
        for (;;) {
          const { done, value } = await reader.read();
          pending += value ?? "";
          const lastBreak = done ? pending.length : pending.lastIndexOf("\n\n");
          if (lastBreak > 0) {
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
        stretch.to = Math.max(stretch.to, lastStart);
      } catch (error) {
        if (!stretch.abort.signal.aborted) report("player", "journal.subtitles.read", error);
        drop(stretch);
      }
    };

    const check = () => {
      const { time, duration, busy } = clock();
      for (const stretch of [...stretches]) {
        if (!stretch.done && (time < stretch.from - leadSeconds || time >= stretch.to)) {
          stretch.abort.abort();
          drop(stretch);
        }
      }
      const current = covering(time);
      if (!current) {
        void load(Math.max(0, time - leadSeconds));
      } else if (!busy && current.to - time < fetchAheadSeconds && current.to < duration && !covering(current.to)) {
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
