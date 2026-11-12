import { useEffect, useRef, useState } from "react";
import { backend, isDesktop, type PrintTarget, type SoundSegments } from "../lib/backend";
import { fileProgress, useTorrents } from "../state/torrents";

type Part = "head" | "tail";

const regionShare = 0.25;
const headLongestSeconds = 600;
const tailLongestSeconds = 420;
const regionShortestSeconds = 90;
const shortestEpisodeSeconds = 8 * 60;
const tailLeadSeconds = 150;
const headMarginSeconds = 30;
const decoderMissing = "decoder_missing";
const printCancelled = "print_cancelled";

export function regionSeconds(duration: number, part: Part): number {
  const longest = part === "head" ? headLongestSeconds : tailLongestSeconds;
  return Math.min(longest, Math.max(regionShortestSeconds, duration * regionShare));
}

function keyOf(target: PrintTarget): string {
  return `${target.infoHash}-${target.fileIndex}`;
}

function downloaded(target: PrintTarget): boolean {
  return fileProgress(useTorrents.getState().byHash[target.infoHash], target.fileIndex) >= 1;
}

interface Options {
  enabled: boolean;
  target: PrintTarget | null;
  neighbours: PrintTarget[];
  duration: number;
  current: number;
  startAt: number;
  playing: boolean;
  buffering: boolean;
  needIntro: boolean;
  needCredits: boolean;
}

export function useSoundSegments(options: Options): SoundSegments | null {
  const { enabled, target, neighbours, duration, current, startAt, playing, buffering, needIntro, needCredits } = options;
  const [segments, setSegments] = useState<SoundSegments | null>(null);
  const attempted = useRef(new Set<string>());
  const decoderAbsent = useRef(false);
  const latest = useRef({ target, neighbours, duration });
  latest.current = { target, neighbours, duration };
  const targetKey = target ? keyOf(target) : "";
  const neighbourKeys = neighbours.map(keyOf).join(",");
  const targetDownloaded = useTorrents((state) => (target ? fileProgress(state.byHash[target.infoHash], target.fileIndex) >= 1 : false));
  const active = enabled && isDesktop && target !== null && duration >= shortestEpisodeSeconds;

  const refresh = useRef(async () => {
    const { target: own, neighbours: others, duration: length } = latest.current;
    if (!own || others.length === 0 || length <= 0) return;
    try {
      const found = await backend.audioSegments(own, length, others);
      if (keyOf(own) === (latest.current.target ? keyOf(latest.current.target) : "")) setSegments(found);
    } catch {
      return;
    }
  });

  const print = useRef(async (which: PrintTarget, part: Part): Promise<boolean> => {
    const attempt = `${keyOf(which)}:${part}`;
    if (decoderAbsent.current || attempted.current.has(attempt)) return false;
    attempted.current.add(attempt);
    try {
      return await backend.audioPrint(which, part, regionSeconds(latest.current.duration, part));
    } catch (error) {
      if (error === decoderMissing) decoderAbsent.current = true;
      if (error === printCancelled) attempted.current.delete(attempt);
      return false;
    }
  });

  useEffect(() => {
    setSegments(null);
    if (!targetKey) return;
    return () => {
      void backend.audioPrintCancel().catch(() => undefined);
    };
  }, [targetKey]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      await refresh.current();
      const parts: Part[] = [...(needIntro ? (["head"] as const) : []), ...(needCredits ? (["tail"] as const) : [])];
      let added = false;
      for (const part of parts) {
        for (const other of latest.current.neighbours) {
          if (cancelled) return;
          if (downloaded(other) && (await print.current(other, part))) added = true;
        }
      }
      if (added && !cancelled) await refresh.current();
    })();
    return () => {
      cancelled = true;
    };
  }, [active, targetKey, neighbourKeys, needIntro, needCredits]);

  const headWanted = active && needIntro && (targetDownloaded || (startAt < regionSeconds(duration, "head") - headMarginSeconds && playing && !buffering));
  useEffect(() => {
    if (!headWanted || !target) return;
    void print.current(target, "head").then((made) => (made ? refresh.current() : undefined));
  }, [headWanted, targetKey]);

  const tailWanted = active && needCredits && (targetDownloaded || current >= duration - regionSeconds(duration, "tail") - tailLeadSeconds);
  useEffect(() => {
    if (!tailWanted || !target) return;
    void print.current(target, "tail").then((made) => (made ? refresh.current() : undefined));
  }, [tailWanted, targetKey]);

  return active ? segments : null;
}
