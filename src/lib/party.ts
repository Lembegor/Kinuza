export const partyProto = 1;
export const partyRoomLimit = 8;
export const partyChatLimit = 500;
export const partyReactions = ["laugh", "wow", "scary", "sad", "fire", "heart"] as const;
export type PartyReaction = (typeof partyReactions)[number];

export interface PartyMedia {
  type: "movie" | "tv";
  id: number;
  title: string;
  poster?: string;
  year?: string;
  season?: number;
  episode?: number;
  episodeName?: string;
  infoHash: string;
  fileIndex: number;
  releaseId?: string;
  fileName?: string;
  size?: number;
  quality?: string;
  torrentName?: string;
  tags?: string[];
  pickId?: string;
  donorId?: string;
}

export interface PartyGate {
  id: string;
  pos: number;
  resume: boolean;
  since: number;
  waiting: number[];
}

export interface PartyState {
  seq: number;
  playing: boolean;
  pos: number;
  at: number;
  rate: number;
  gate: PartyGate | null;
  by: number;
  reason: string;
  countdown: boolean;
  now: number;
}

export interface PartyTrack {
  label: string;
  lang: string;
  kind: string;
  index?: number;
}

export interface PartyStatus {
  loaded?: boolean;
  waiting?: boolean;
  away?: boolean;
  synced?: boolean;
  has?: boolean;
  behind?: boolean;
  ahead?: number;
  drift?: number;
  pct?: number;
  down?: number;
  port?: number;
  audio?: PartyTrack;
  sub?: PartyTrack;
}

export interface PartyMember {
  id: number;
  name: string;
  avatar: string | null;
  online: boolean;
  skipped: boolean;
  status: PartyStatus;
  ip: string;
}

export interface PartySettings {
  control: "all" | "host";
  wait: boolean;
  friends: boolean;
  autoNext: boolean;
}

export interface PartyMessage {
  id: number;
  from: number;
  kind: "text" | "joined" | "left" | "kicked" | "media" | "skipped" | "host";
  text?: string;
  at: number;
  pos: number;
  name?: string;
  title?: string;
  season?: number | null;
  episode?: number | null;
  target?: number;
  suggest?: PartySuggest;
}

export interface PartySuggest {
  type: "movie" | "tv";
  id: number;
  title: string;
  poster?: string;
  year?: string;
}

export function sameMedia(one: PartyMedia | null | undefined, other: PartyMedia | null | undefined): boolean {
  return !!one && !!other && one.infoHash === other.infoHash && one.fileIndex === other.fileIndex;
}

export function roomPosition(state: PartyState, serverNow: number): number {
  if (state.playing && serverNow > state.at) return state.pos + (serverNow - state.at) * state.rate;
  return state.pos;
}

export function localClock(): number {
  return (performance.timeOrigin + performance.now()) / 1000;
}

interface ClockSample {
  offset: number;
  rtt: number;
  at: number;
}

const keptSamples = 12;
const bestSamples = 3;

export class ClockSync {
  private samples: ClockSample[] = [];
  private offsetNow = 0;

  add(sentAt: number, serverAt: number, receivedAt: number): void {
    const rtt = Math.max(0, receivedAt - sentAt);
    const offset = serverAt + rtt / 2 - receivedAt;
    this.samples.push({ offset, rtt, at: receivedAt });
    if (this.samples.length > keptSamples) this.samples.shift();
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, bestSamples);
    const offsets = best.map((sample) => sample.offset).sort((a, b) => a - b);
    this.offsetNow = offsets[Math.floor(offsets.length / 2)];
  }

  get ready(): boolean {
    return this.samples.length > 0;
  }

  get offset(): number {
    return this.offsetNow;
  }

  get rtt(): number {
    return this.samples.length ? Math.min(...this.samples.map((sample) => sample.rtt)) : 0;
  }

  serverNow(): number {
    return localClock() + this.offsetNow;
  }

  reset(): void {
    this.samples = [];
    this.offsetNow = 0;
  }
}

export const driftIgnore = 0.08;
export const driftSettled = 0.03;
export const driftSeek = 1.5;
const nudgeGain = 0.2;
const nudgeMin = 0.02;
const nudgeMax = 0.05;

export type Correction = { kind: "none" } | { kind: "rate"; factor: number } | { kind: "seek" };

export function correction(drift: number, nudging: boolean): Correction {
  const size = Math.abs(drift);
  if (size >= driftSeek) return { kind: "seek" };
  if (size < (nudging ? driftSettled : driftIgnore)) return { kind: "none" };
  const step = Math.min(nudgeMax, Math.max(nudgeMin, size * nudgeGain));
  return { kind: "rate", factor: drift > 0 ? 1 - step : 1 + step };
}

export function aheadOf(ranges: { start: number; end: number }[], time: number): number {
  const range = ranges.find((item) => item.start - 0.5 <= time && time <= item.end + 0.05);
  return range ? Math.max(0, range.end - time) : 0;
}

export function cleanRoomCode(text: string): string {
  const fromLink = /\/r\/([A-Za-z0-9-]+)/.exec(text)?.[1] ?? text;
  return fromLink.toUpperCase().replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g, "").slice(0, 6);
}

export function formatRoomCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

export function roomLink(code: string): string {
  return `https://kinuza.channeluza.com/r/${code}`;
}

export function chatParts(text: string): { text: string; spoiler: boolean }[] {
  const parts: { text: string; spoiler: boolean }[] = [];
  const pattern = /\|\|([^|]+)\|\|/g;
  let last = 0;
  for (const found of text.matchAll(pattern)) {
    if (found.index > last) parts.push({ text: text.slice(last, found.index), spoiler: false });
    parts.push({ text: found[1], spoiler: true });
    last = found.index + found[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), spoiler: false });
  return parts;
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${minutes}:${two(rest)}`;
}
