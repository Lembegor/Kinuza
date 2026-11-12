import { useEffect, useRef, type RefObject } from "react";
import { audioStreamUrl } from "../lib/backend";

const syncIntervalMs = 60;
const startLeadSeconds = 0.6;
const longestStartLeadSeconds = 3;
const audibleDriftSeconds = 0.07;
const seekSettleSeconds = 0.05;
const seekAttemptsBeforeRestart = 4;
const stalledAfterMs = 8000;
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

export function useConvertedAudio(
  videoRef: RefObject<HTMLVideoElement | null>,
  source: { infoHash: string; fileIndex: number } | null,
  track: number | null,
  volume: number,
  muted: boolean,
  delay = 0,
): void {
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
      audio.volume = Math.min(1, levels.current.volume);
      audio.muted = levels.current.muted;
      if (audio.playbackRate !== video.playbackRate) audio.playbackRate = video.playbackRate;

      const target = video.currentTime - levels.current.delay - streamStart.current;
      const pictureRunning = !video.paused && !video.ended && !video.seeking && video.readyState >= haveFutureData;

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
      audio.removeAttribute("src");
      audio.load();
    };
  }, [sourceKey, track]); // eslint-disable-line react-hooks/exhaustive-deps
}
