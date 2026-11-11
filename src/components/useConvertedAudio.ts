// Sound for audio tracks the built-in player cannot decode (AC-3, E-AC-3, DTS and the like).
// The backend converts the chosen track with FFmpeg as it plays; a hidden <audio> element plays
// the result and is kept in step with the picture.

import { useEffect, useRef, type RefObject } from "react";
import { audioStreamUrl } from "../lib/backend";

const syncIntervalMs = 60;
/** The converted stream needs a moment to start, so it is asked to begin this far ahead of the picture. */
const startLeadSeconds = 0.6;
const longestStartLeadSeconds = 3;
/** Sound this far from the picture starts to be noticeable and gets corrected. */
const audibleDriftSeconds = 0.07;
/** A jump inside the buffer takes about this long to take effect, so it aims this far ahead. */
const seekSettleSeconds = 0.05;
/** Corrections by seeking inside what is already buffered that may fail before the stream is restarted. */
const seekAttemptsBeforeRestart = 4;
/** A stream that has produced nothing for this long is restarted. */
const stalledAfterMs = 8000;
/** `HTMLMediaElement.readyState` values: enough for the current frame, enough to keep playing. */
const haveCurrentData = 2;
const haveFutureData = 3;

function bufferedAround(audio: HTMLAudioElement, time: number): boolean {
  const ranges = audio.buffered;
  for (let index = 0; index < ranges.length; index++) {
    if (ranges.start(index) <= time && time < ranges.end(index) - 0.1) return true;
  }
  return false;
}

function bufferedEnd(audio: HTMLAudioElement): number {
  return audio.buffered.length > 0 ? audio.buffered.end(audio.buffered.length - 1) : 0;
}

/**
 * Plays audio track `track` (its position among the file's audio tracks) through conversion,
 * following the video element. `null` turns it off. The video's own sound has to be muted by the
 * caller while this is on. `delay` plays the sound that many seconds later than the file says
 * (negative: earlier), for releases whose sound and picture do not line up.
 */
export function useConvertedAudio(
  videoRef: RefObject<HTMLVideoElement | null>,
  source: { infoHash: string; fileIndex: number } | null,
  track: number | null,
  volume: number,
  muted: boolean,
  delay = 0,
): void {
  /** Film time at which the current converted stream begins. */
  const streamStart = useRef(0);
  const lead = useRef(startLeadSeconds);
  const failedSeeks = useRef(0);
  const waitingSince = useRef(0);
  const levels = useRef({ volume, muted, delay });
  levels.current = { volume, muted, delay };

  const sourceKey = source ? `${source.infoHash}:${source.fileIndex}` : "";

  useEffect(() => {
    if (track === null || !source) return;
    const audio = new Audio();
    audio.preload = "auto";
    lead.current = startLeadSeconds;

    let disposed = false;
    /** Asks the backend for the track from where the picture is (a little ahead if it is moving). */
    const restart = () => {
      const video = videoRef.current;
      if (!video) return;
      const moving = !video.paused && !video.seeking;
      const start = Math.max(0, video.currentTime - levels.current.delay + (moving ? lead.current : 0));
      streamStart.current = start;
      failedSeeks.current = 0;
      waitingSince.current = performance.now();
      void audioStreamUrl(source.infoHash, source.fileIndex, track, start).then((url) => {
        if (disposed) return;
        audio.src = url;
        audio.load();
      });
    };
    restart();

    const timer = setInterval(() => {
      const video = videoRef.current;
      if (!video || !audio.src) return;
      audio.volume = levels.current.volume;
      audio.muted = levels.current.muted;
      if (audio.playbackRate !== video.playbackRate) audio.playbackRate = video.playbackRate;

      // Where in the converted stream the picture currently is; negative while it has not reached the stream's start.
      const target = video.currentTime - levels.current.delay - streamStart.current;
      const pictureRunning = !video.paused && !video.ended && !video.seeking && video.readyState >= haveFutureData;

      // The picture went back before this stream begins, or far past what has been converted: start anew.
      const behindStream = target < -longestStartLeadSeconds - 1;
      const pastStream = audio.buffered.length > 0 && target > bufferedEnd(audio) + 2;
      if (behindStream || pastStream) {
        restart();
        return;
      }
      if (audio.readyState < haveCurrentData) {
        if (performance.now() - waitingSince.current > stalledAfterMs) restart();
        return;
      }
      waitingSince.current = performance.now();

      if (!pictureRunning || target < 0) {
        if (!audio.paused) audio.pause();
        return;
      }

      const drift = audio.currentTime - target;
      if (Math.abs(drift) > audibleDriftSeconds) {
        if (failedSeeks.current >= seekAttemptsBeforeRestart) {
          // Jumping inside the buffer does not work here; give the next stream more of a head start instead.
          lead.current = Math.min(longestStartLeadSeconds, lead.current * 2);
          restart();
          return;
        }
        failedSeeks.current += 1;
        if (bufferedAround(audio, target + seekSettleSeconds)) audio.currentTime = target + seekSettleSeconds;
      } else {
        failedSeeks.current = 0;
      }
      if (audio.paused) void audio.play().catch(() => undefined);
    }, syncIntervalMs);

    return () => {
      disposed = true;
      clearInterval(timer);
      audio.pause();
      // Dropping the source closes the connection, which stops the conversion on the backend.
      audio.removeAttribute("src");
      audio.load();
    };
  }, [sourceKey, track]); // eslint-disable-line react-hooks/exhaustive-deps
}
