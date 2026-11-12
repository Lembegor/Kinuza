import { useEffect, type RefObject } from "react";
import type { AudioMode } from "../../state/settings";

interface Chain {
  source: MediaElementAudioSourceNode;
  nodes: AudioNode[];
  gain: GainNode;
  mode: AudioMode | null;
}

let context: AudioContext | null = null;
const chains = new WeakMap<HTMLMediaElement, Chain>();

function audioContext(): AudioContext | null {
  if (context) return context;
  try {
    context = new AudioContext();
  } catch {
    return null;
  }
  return context;
}

function compressor(ctx: AudioContext, threshold: number, knee: number, ratio: number, attack: number, release: number): DynamicsCompressorNode {
  const node = ctx.createDynamicsCompressor();
  node.threshold.value = threshold;
  node.knee.value = knee;
  node.ratio.value = ratio;
  node.attack.value = attack;
  node.release.value = release;
  return node;
}

function gain(ctx: AudioContext, value: number): GainNode {
  const node = ctx.createGain();
  node.gain.value = value;
  return node;
}

function filter(ctx: AudioContext, type: BiquadFilterType, frequency: number, q: number, boost = 0): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = q;
  node.gain.value = boost;
  return node;
}

function effectNodes(ctx: AudioContext, mode: AudioMode): AudioNode[] {
  const limiter = compressor(ctx, -1, 0, 20, 0.003, 0.1);
  switch (mode) {
    case "night":
      return [compressor(ctx, -30, 10, 8, 0.01, 0.3), gain(ctx, 1.7), limiter];
    case "level":
      return [compressor(ctx, -40, 24, 3, 0.05, 1), gain(ctx, 1.8), limiter];
    case "dialogue":
      return [
        filter(ctx, "highpass", 100, 0.7),
        filter(ctx, "peaking", 2600, 1.1, 6),
        filter(ctx, "peaking", 250, 1, -3),
        compressor(ctx, -24, 6, 3, 0.01, 0.2),
        gain(ctx, 1.3),
        limiter,
      ];
    default:
      return [];
  }
}

function connect(chain: Chain, ctx: AudioContext, mode: AudioMode): void {
  chain.source.disconnect();
  for (const node of chain.nodes) node.disconnect();
  chain.gain.disconnect();
  chain.nodes = effectNodes(ctx, mode);
  chain.mode = mode;
  let tail: AudioNode = chain.source;
  for (const node of chain.nodes) {
    tail.connect(node);
    tail = node;
  }
  tail.connect(chain.gain);
  chain.gain.connect(ctx.destination);
}

export function needsAudioGraph(mode: AudioMode, volume: number): boolean {
  return mode !== "off" || volume > 1;
}

export function useAudioEffects(videoRef: RefObject<HTMLVideoElement | null>, active: boolean, url: string | null, mode: AudioMode, volume: number, muted: boolean): void {
  useEffect(() => {
    const video = videoRef.current;
    if (!active || !video) return;
    let chain = chains.get(video);
    if (!chain && !needsAudioGraph(mode, volume)) {
      video.volume = Math.min(1, volume);
      video.muted = muted;
      return;
    }
    const ctx = audioContext();
    if (!ctx) {
      video.volume = Math.min(1, volume);
      return;
    }
    if (!chain) {
      try {
        chain = { source: ctx.createMediaElementSource(video), nodes: [], gain: ctx.createGain(), mode: null };
      } catch {
        video.volume = Math.min(1, volume);
        return;
      }
      chains.set(video, chain);
    }
    if (chain.mode !== mode) connect(chain, ctx, mode);
    video.volume = 1;
    video.muted = muted;
    chain.gain.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  }, [videoRef, active, url, mode, volume, muted]);

  useEffect(() => {
    if (!active) return;
    const resume = () => {
      if (context?.state === "suspended") void context.resume().catch(() => undefined);
    };
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
    return () => {
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
    };
  }, [active]);
}
