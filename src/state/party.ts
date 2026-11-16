import { create } from "zustand";
import { accountApi } from "../lib/accountApi";
import { backend, describeError, getAppInfo, type TorrentPreview } from "../lib/backend";
import { t } from "../lib/i18n";
import { report } from "../lib/journal";
import {
  ClockSync,
  formatClock,
  localClock,
  partyProto,
  sameMedia,
  type PartyMedia,
  type PartyMember,
  type PartyMessage,
  type PartyReaction,
  type PartySettings,
  type PartyState,
  type PartyStatus,
  type PartySuggest,
  type PartyTrack,
} from "../lib/party";
import { rutracker } from "../lib/rutracker";
import { inspectTracker, isRutrackerId } from "../lib/trackers";
import { toSource } from "../lib/releaseUpdate";
import { useAccount } from "./account";
import { useAutoPick } from "./autoPick";
import { useLibrary, unitKey, type Source, type TitleRef } from "./library";
import { useReleaseWatch } from "./releaseWatch";
import { useSettings } from "./settings";
import { useTorrents } from "./torrents";
import { useUi, type PlayerSession } from "./ui";

export type PartyPhase = "idle" | "connecting" | "live" | "reconnecting";
export type PartyTab = "chat" | "people";

export interface PartyNotice {
  id: number;
  text: string;
  undo?: number;
  at: number;
}

export interface PartyBurst {
  id: number;
  from: number;
  e: PartyReaction;
  at: number;
}

interface PartyHooks {
  subtitle: (() => { name: string; text: string } | null) | null;
  applySubtitle: ((name: string, text: string) => void) | null;
  applyTracks: ((audio: PartyTrack | undefined, sub: PartyTrack | undefined, from: number) => void) | null;
}

export const partyHooks: PartyHooks = { subtitle: null, applySubtitle: null, applyTracks: null };

interface PartyStore {
  phase: PartyPhase;
  code: string | null;
  me: number;
  host: number;
  settings: PartySettings;
  media: PartyMedia | null;
  state: PartyState | null;
  members: PartyMember[];
  chat: PartyMessage[];
  typing: Record<number, number>;
  unread: number;
  bursts: PartyBurst[];
  notices: PartyNotice[];
  preparing: boolean;
  prepareError: string | null;
  panelOpen: boolean;
  tab: PartyTab;
  lastLeft: { code: string; at: number } | null;
  lag: number;
  joinOpen: boolean;
  joinCode: string;
  inviteOpen: boolean;
  create: () => Promise<void>;
  join: (code: string) => Promise<void>;
  leave: () => void;
  setPanel: (open: boolean, tab?: PartyTab) => void;
  setLag: (seconds: number) => void;
  showJoin: (open: boolean, code?: string) => void;
  showInvite: (open: boolean) => void;
}

const defaultSettings: PartySettings = { control: "all", wait: true, friends: false, autoNext: true };
const pingBurst = 8;
const pingGapMs = 120;
const pingEveryMs = 30_000;
const statusEveryMs = 5000;
const noticeMs = 3500;
const undoMs = 5000;
const burstMs = 2200;
const typingMs = 4000;
const chatKept = 200;
const reconnectSteps = [1000, 2000, 4000, 8000, 15000, 30000];
const lastLeftMs = 2 * 60_000;
const torrentCacheSeconds = 6 * 3600;
const lagKey = "kinuza-party-lag";

export const clock = new ClockSync();
let socket: WebSocket | null = null;
let intentional = false;
let attempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let lastStatus: PartyStatus = {};
let lastStatusKey = "";
let lastStatusAt = 0;
let noticeId = 1;
let preparedFor = "";
let peersSent = new Set<string>();
const uploadOpened = new Set<string>();

function storedLag(): number {
  try {
    const value = Number(localStorage.getItem(lagKey));
    return Number.isFinite(value) ? Math.min(0.5, Math.max(0, value)) : 0;
  } catch {
    return 0;
  }
}

export const useParty = create<PartyStore>((set, get) => ({
  phase: "idle",
  code: null,
  me: 0,
  host: 0,
  settings: defaultSettings,
  media: null,
  state: null,
  members: [],
  chat: [],
  typing: {},
  unread: 0,
  bursts: [],
  notices: [],
  preparing: false,
  prepareError: null,
  panelOpen: false,
  tab: "chat",
  lastLeft: null,
  lag: storedLag(),
  joinOpen: false,
  joinCode: "",
  inviteOpen: false,

  async create() {
    if (get().phase !== "idle") return;
    await connect({ t: "create", settings: {} });
  },

  async join(code) {
    if (get().code === code && get().phase !== "idle") {
      set({ panelOpen: true });
      return;
    }
    if (get().phase !== "idle") leaveRoom(false);
    await connect({ t: "join", code });
  },

  leave() {
    leaveRoom(true);
  },

  setPanel(open, tab) {
    set((state) => ({ panelOpen: open, tab: tab ?? state.tab, unread: open && (tab ?? state.tab) === "chat" ? 0 : state.unread }));
  },

  setLag(seconds) {
    const lag = Math.min(0.5, Math.max(0, seconds));
    try {
      localStorage.setItem(lagKey, String(lag));
    } catch {
      return set({ lag });
    }
    set({ lag });
  },

  showJoin: (open, code = "") => set({ joinOpen: open, joinCode: code }),
  showInvite: (open) => set({ inviteOpen: open }),
}));

export function inRoom(): boolean {
  const phase = useParty.getState().phase;
  return phase === "live" || phase === "reconnecting";
}

export function isHost(): boolean {
  const state = useParty.getState();
  return inRoom() && state.host === state.me;
}

export function canControl(): boolean {
  const state = useParty.getState();
  return inRoom() && (state.settings.control === "all" || state.host === state.me);
}

export function memberName(id: number): string {
  return useParty.getState().members.find((member) => member.id === id)?.name || t("friends.someone");
}

function send(message: Record<string, unknown>): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function notice(text: string, undo?: number): void {
  const id = noticeId++;
  useParty.setState((state) => ({ notices: [...state.notices.slice(-2), { id, text, undo, at: Date.now() }] }));
  setTimeout(() => useParty.setState((state) => ({ notices: state.notices.filter((item) => item.id !== id) })), undo !== undefined ? undoMs : noticeMs);
}

async function socketUrl(): Promise<string> {
  let base = useAccount.getState().base;
  if (!base) base = (await accountApi.status()).base;
  const { ticket } = await accountApi.partyTicket();
  return `${base.replace(/^http/i, "ws")}party/ws?ticket=${encodeURIComponent(ticket)}`;
}

async function connect(hello: Record<string, unknown>): Promise<void> {
  if (useAccount.getState().phase !== "signedIn") {
    useUi.getState().toast(t("party.needAccount"), "info");
    return;
  }
  clearTimeout(reconnectTimer);
  intentional = false;
  useParty.setState({ phase: useParty.getState().code ? "reconnecting" : "connecting" });
  let url: string;
  try {
    url = await socketUrl();
  } catch (error) {
    failedToConnect(error);
    return;
  }
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ ...hello, proto: partyProto }));
    startClock();
  };
  ws.onmessage = (event) => {
    if (socket !== ws) return;
    try {
      receive(JSON.parse(String(event.data)) as Record<string, unknown>);
    } catch (error) {
      report("party", "journal.party.message", error);
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    clearInterval(pingTimer);
    closed();
  };
}

function failedToConnect(error: unknown): void {
  const { code } = useParty.getState();
  if (code && !intentional) {
    scheduleReconnect();
    return;
  }
  useParty.setState({ phase: "idle" });
  useUi.getState().toast(describeError(error), "error");
}

function closed(): void {
  const { code, phase } = useParty.getState();
  if (intentional || !code) {
    if (phase !== "idle") resetRoom();
    return;
  }
  useParty.setState({ phase: "reconnecting" });
  scheduleReconnect();
}

function scheduleReconnect(): void {
  clearTimeout(reconnectTimer);
  const delay = reconnectSteps[Math.min(attempts, reconnectSteps.length - 1)];
  attempts += 1;
  reconnectTimer = setTimeout(() => {
    const code = useParty.getState().code;
    if (code && !intentional) void connect({ t: "join", code });
  }, delay);
}

function startClock(): void {
  clearInterval(pingTimer);
  clock.reset();
  for (let index = 0; index < pingBurst; index++) setTimeout(() => send({ t: "ping", c: localClock() }), index * pingGapMs);
  pingTimer = setInterval(() => send({ t: "ping", c: localClock() }), pingEveryMs);
}

function leaveRoom(say: boolean): void {
  const code = useParty.getState().code;
  intentional = true;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  if (say) send({ t: "leave" });
  socket?.close();
  socket = null;
  resetRoom();
  if (code && say) useParty.setState({ lastLeft: { code, at: Date.now() } });
}

function resetRoom(): void {
  restoreUploads();
  preparedFor = "";
  peersSent = new Set();
  lastStatusKey = "";
  attempts = 0;
  useParty.setState({
    phase: "idle",
    code: null,
    me: 0,
    host: 0,
    settings: defaultSettings,
    media: null,
    state: null,
    members: [],
    chat: [],
    typing: {},
    unread: 0,
    bursts: [],
    notices: [],
    preparing: false,
    prepareError: null,
    panelOpen: false,
  });
}

function restoreUploads(): void {
  for (const infoHash of uploadOpened) void backend.setUpload(infoHash, false).catch(() => undefined);
  uploadOpened.clear();
}

function receive(message: Record<string, unknown>): void {
  const kind = message.t;
  const store = useParty.getState();
  if (kind === "pong") {
    clock.add(Number(message.c), Number(message.s), localClock());
    return;
  }
  if (kind === "room") {
    attempts = 0;
    const media = (message.media as PartyMedia | null) ?? null;
    const previous = store.media;
    useParty.setState({
      phase: "live",
      code: String(message.code),
      me: Number(message.me),
      host: Number(message.host),
      settings: message.settings as PartySettings,
      media,
      state: message.state as PartyState,
      members: message.members as PartyMember[],
      chat: (message.chat as PartyMessage[]).slice(-chatKept),
      panelOpen: store.phase === "connecting" ? true : store.panelOpen,
      lastLeft: null,
    });
    lastStatusKey = "";
    flushStatus();
    mediaChanged(previous, media, store.phase === "connecting");
    sharePeers();
    return;
  }
  if (kind === "state") {
    const state = message.state as PartyState;
    const media = (message.media as PartyMedia | null) ?? null;
    const previous = store.media;
    const before = store.state;
    useParty.setState({ state, media });
    describeChange(before, state);
    mediaChanged(previous, media, false);
    return;
  }
  if (kind === "members") {
    useParty.setState({ host: Number(message.host), settings: message.settings as PartySettings, members: message.members as PartyMember[] });
    sharePeers();
    return;
  }
  if (kind === "member") {
    const id = Number(message.id);
    const status = message.status as PartyStatus;
    useParty.setState((state) => ({ members: state.members.map((member) => (member.id === id ? { ...member, status } : member)) }));
    if (status.port) sharePeers();
    return;
  }
  if (kind === "chat") {
    const item = message.msg as PartyMessage;
    const mine = item.from === store.me;
    const reading = store.panelOpen && store.tab === "chat";
    useParty.setState((state) => ({
      chat: [...state.chat, item].slice(-chatKept),
      unread: !mine && !reading && item.kind === "text" ? state.unread + 1 : state.unread,
      typing: Object.fromEntries(Object.entries(state.typing).filter(([id]) => Number(id) !== item.from)),
    }));
    const me = store.members.find((member) => member.id === store.me);
    if (!mine && item.kind === "text" && me?.name && item.text?.toLowerCase().includes(`@${me.name.toLowerCase()}`)) {
      notice(t("party.notice.mention", { name: memberName(item.from) }));
    }
    return;
  }
  if (kind === "react") {
    const burst = { id: noticeId++, from: Number(message.from), e: message.e as PartyReaction, at: Date.now() };
    useParty.setState((state) => ({ bursts: [...state.bursts.slice(-11), burst] }));
    setTimeout(() => useParty.setState((state) => ({ bursts: state.bursts.filter((item) => item.id !== burst.id) })), burstMs);
    return;
  }
  if (kind === "typing") {
    const from = Number(message.from);
    useParty.setState((state) => ({ typing: { ...state.typing, [from]: Date.now() } }));
    setTimeout(() => useParty.setState((state) => (Date.now() - (state.typing[from] ?? 0) >= typingMs ? { typing: Object.fromEntries(Object.entries(state.typing).filter(([id]) => Number(id) !== from)) } : {})), typingMs + 50);
    return;
  }
  if (kind === "invited") {
    useUi.getState().toast(t("party.toast.invited"), "success");
    return;
  }
  if (kind === "subreq") {
    const subtitle = partyHooks.subtitle?.();
    if (subtitle) send({ t: "subtext", to: Number(message.from), name: subtitle.name, text: subtitle.text });
    return;
  }
  if (kind === "subtext") {
    partyHooks.applySubtitle?.(String(message.name || "subtitles.srt"), String(message.text || ""));
    return;
  }
  if (kind === "kicked") {
    leaveRoom(false);
    useUi.getState().toast(t("party.toast.kicked"), "info");
    return;
  }
  if (kind === "moved") {
    leaveRoom(false);
    useUi.getState().toast(t("party.toast.moved"), "info");
    return;
  }
  if (kind === "error") {
    const code = String(message.code);
    if (store.phase === "connecting" || store.phase === "reconnecting") {
      const wasIn = store.code;
      leaveRoom(false);
      useUi.getState().toast(wasIn && code === "party_not_found" ? t("party.toast.closed") : describeError(code), "error");
      return;
    }
    useUi.getState().toast(describeError(code), "error");
  }
}

function describeChange(before: PartyState | null, after: PartyState): void {
  const { me } = useParty.getState();
  if (!before || after.seq === before.seq || after.by === me || after.by === 0) return;
  const name = memberName(after.by);
  if (after.reason === "pause") notice(t("party.notice.paused", { name }));
  else if (after.reason === "play") notice(t("party.notice.resumed", { name }));
  else if (after.reason === "seek") notice(t("party.notice.seeked", { name, time: formatClock(after.gate?.pos ?? after.pos) }), before.playing ? before.pos + Math.max(0, after.now - before.at) * before.rate : before.pos);
  else if (after.reason === "rate") notice(t("party.notice.rate", { name, rate: after.rate }));
}

export function sendControl(action: "pause" | "play" | "seek" | "rate", value?: number): void {
  if (action === "rate") send({ t: "control", a: "rate", rate: value });
  else send({ t: "control", a: action, pos: value });
}

export function sendReady(gate: string): void {
  send({ t: "ready", gate });
}

export function sendStall(pos: number): void {
  send({ t: "stall", pos });
}

export function sendSkip(id: number): void {
  send({ t: "skip", id });
}

export function sendChat(text: string, suggest?: PartySuggest): void {
  const clean = text.trim();
  if (!clean && !suggest) return;
  send({ t: "chat", text: clean || (suggest ? suggest.title : ""), ...(suggest ? { suggest } : {}) });
}

export function sendReaction(e: PartyReaction): void {
  send({ t: "react", e });
}

export function sendTyping(): void {
  send({ t: "typing" });
}

export function sendSettings(change: Partial<PartySettings>): void {
  send({ t: "settings", settings: { ...useParty.getState().settings, ...change } });
}

export function makeHost(id: number): void {
  send({ t: "host", id });
}

export function kickMember(id: number): void {
  send({ t: "kick", id });
}

export function inviteFriend(id: number): void {
  send({ t: "invite", to: id });
}

export function requestSubtitles(from: number): void {
  send({ t: "subreq", to: from });
}

export function shareMedia(media: PartyMedia, pos: number, autostart: boolean): void {
  preparedFor = mediaKey(media);
  send({ t: "media", media, pos, autostart });
}

export function partyStatus(status: PartyStatus): void {
  lastStatus = status;
  const key = JSON.stringify({ ...status, drift: Math.round((status.drift ?? 0) * 4) / 4, ahead: Math.round(status.ahead ?? 0), pct: Math.round((status.pct ?? 0) / 5) });
  const due = Date.now() - lastStatusAt >= statusEveryMs;
  if (key === lastStatusKey && !due) return;
  if (key !== lastStatusKey && Date.now() - lastStatusAt < 300) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(flushStatus, 300);
    return;
  }
  lastStatusKey = key;
  flushStatus();
}

function flushStatus(): void {
  clearTimeout(statusTimer);
  const port = listenPort;
  if (send({ t: "status", s: { ...lastStatus, ...(port ? { port } : {}) } })) lastStatusAt = Date.now();
}

let listenPort = 0;
void getAppInfo()
  .then((info) => {
    listenPort = info.listenPort;
  })
  .catch(() => undefined);

function mediaKey(media: PartyMedia): string {
  return `${media.infoHash}:${media.fileIndex}`;
}

export function unitOf(media: PartyMedia): string {
  return unitKey(media.type, media.id, media.season, media.episode);
}

export function sessionOf(media: PartyMedia): PlayerSession {
  const title: TitleRef = { type: media.type, id: media.id, title: media.title, poster: media.poster ?? null, backdrop: null, year: media.year ?? "" };
  return {
    title,
    unitKey: unitOf(media),
    ...(media.type === "tv" ? { season: media.season, episode: media.episode, episodeName: media.episodeName } : {}),
    preferredSourceId: mediaKey(media),
  };
}

function playerShows(media: PartyMedia): boolean {
  const player = useUi.getState().player;
  if (!player || player.unitKey !== unitOf(media)) return false;
  return !player.preferredSourceId || player.preferredSourceId === mediaKey(media);
}

function mediaChanged(previous: PartyMedia | null, media: PartyMedia | null, first: boolean): void {
  if (!media) return;
  if (sameMedia(previous, media) && !first && preparedFor === mediaKey(media)) return;
  if (preparedFor === mediaKey(media) && playerShows(media)) return;
  preparedFor = mediaKey(media);
  void openRoomMedia(media);
}

export async function openRoomMedia(media: PartyMedia): Promise<void> {
  useParty.setState({ preparing: true, prepareError: null });
  try {
    await ensureSource(media);
    if (!sameMedia(useParty.getState().media, media)) return;
    restoreUploadsExcept(media.infoHash);
    await openUpload(media.infoHash);
    peersSent = new Set();
    sharePeers();
    if (!playerShows(media)) useUi.getState().play(sessionOf(media));
    useParty.setState({ preparing: false });
  } catch (error) {
    report("party", "journal.party.source", error);
    useParty.setState({ preparing: false, prepareError: describeError(error) });
  }
}

function restoreUploadsExcept(infoHash: string): void {
  for (const hash of [...uploadOpened]) {
    if (hash === infoHash) continue;
    void backend.setUpload(hash, false).catch(() => undefined);
    uploadOpened.delete(hash);
  }
}

async function openUpload(infoHash: string): Promise<void> {
  await useTorrents.getState().refresh().catch(() => undefined);
  const torrent = useTorrents.getState().byHash[infoHash];
  if (torrent && !torrent.uploadEnabled) {
    await backend.setUpload(infoHash, true).catch(() => undefined);
    uploadOpened.add(infoHash);
  }
}

function peerList(): string[] {
  const { members, me } = useParty.getState();
  return members
    .filter((member) => member.id !== me && member.online && member.ip && member.status.port)
    .map((member) => (member.ip.includes(":") ? `[${member.ip}]:${member.status.port}` : `${member.ip}:${member.status.port}`));
}

function sharePeers(): void {
  const media = useParty.getState().media;
  if (!media || preparedFor !== mediaKey(media) || useParty.getState().preparing) return;
  const fresh = peerList().filter((peer) => !peersSent.has(peer));
  if (fresh.length === 0) return;
  for (const peer of fresh) peersSent.add(peer);
  void backend.addPeers(media.infoHash, fresh).catch(() => undefined);
}

export function releaseIdOf(infoHash: string): string | undefined {
  for (const entry of Object.values(useAutoPick.getState().entries)) {
    const found = Object.entries(entry.hashes ?? {}).find(([, hash]) => hash === infoHash);
    if (found) return found[0];
  }
  const watch = Object.values(useReleaseWatch.getState().watches).find((item) => item.infoHash === infoHash);
  return watch?.topicId;
}

export function mediaFor(session: PlayerSession, source: Source): PartyMedia {
  return {
    type: session.title.type,
    id: session.title.id,
    title: session.title.title,
    ...(session.title.poster ? { poster: session.title.poster } : {}),
    ...(session.title.year ? { year: session.title.year } : {}),
    ...(session.title.type === "tv" ? { season: session.season, episode: session.episode, episodeName: session.episodeName } : {}),
    infoHash: source.infoHash,
    fileIndex: source.fileIndex,
    ...(releaseIdOf(source.infoHash) ? { releaseId: releaseIdOf(source.infoHash) } : {}),
    fileName: source.fileName,
    size: source.size,
    quality: source.quality,
    torrentName: source.torrentName,
    tags: source.tags.slice(0, 12),
    ...(source.pickId ? { pickId: source.pickId } : {}),
    ...(source.donorId ? { donorId: source.donorId } : {}),
  };
}

async function ensureSource(media: PartyMedia): Promise<void> {
  const unit = unitOf(media);
  const id = mediaKey(media);
  const library = useLibrary.getState();
  const known = (library.sources[unit] ?? []).find((source) => source.id === id);
  const downloadDir = useSettings.getState().downloadDir || null;
  if (known) {
    await backend.addTorrent(media.infoHash, [], downloadDir).catch(() => undefined);
    return;
  }
  let preview: TorrentPreview | null = null;
  if (media.releaseId) {
    try {
      preview = isRutrackerId(media.releaseId) ? await rutracker.inspectRelease(media.releaseId, true, false, torrentCacheSeconds) : await inspectTracker(media.releaseId);
    } catch {
      preview = null;
    }
  }
  if (!preview || preview.infoHash.toLowerCase() !== media.infoHash) {
    const name = media.torrentName ? `&dn=${encodeURIComponent(media.torrentName)}` : "";
    preview = await backend.inspectLink(`magnet:?xt=urn:btih:${media.infoHash}${name}`, peerList());
  }
  const file = preview.files.find((item) => item.index === media.fileIndex);
  if (!file) throw new Error("party_no_source");
  await backend.addTorrent(media.infoHash, [], downloadDir);
  const source: Source = { ...toSource(preview, file), ...(media.pickId ? { pickId: media.pickId } : {}), ...(media.donorId ? { donorId: media.donorId } : {}) };
  useLibrary.getState().addSources([{ unitKey: unit, source }]);
}

export function rejoinLast(): void {
  const last = useParty.getState().lastLeft;
  if (last && Date.now() - last.at < lastLeftMs) void useParty.getState().join(last.code);
}

export function returnToRoom(): void {
  const media = useParty.getState().media;
  if (media) {
    preparedFor = "";
    void openRoomMedia(media);
  }
}

export function memberTracks(id: number): { audio?: PartyTrack; sub?: PartyTrack } {
  const member = useParty.getState().members.find((item) => item.id === id);
  return { audio: member?.status.audio, sub: member?.status.sub };
}

export function copyTracks(id: number): void {
  const { audio, sub } = memberTracks(id);
  partyHooks.applyTracks?.(audio, sub, id);
}

let inviteLoop = false;

export function startInviteLoop(): void {
  if (inviteLoop) return;
  inviteLoop = true;
  void (async () => {
    let pause = 0;
    while (inviteLoop) {
      if (useAccount.getState().phase !== "signedIn") {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        continue;
      }
      try {
        const { invites } = await accountApi.partyWait();
        pause = 0;
        for (const invite of invites) showInvite(invite);
      } catch {
        pause = Math.min(60_000, pause ? pause * 2 : 5000);
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
    }
  })();
}

export function openRoomLink(code: string): void {
  const attempt = (left: number) => {
    const phase = useAccount.getState().phase;
    if (phase === "unknown" && left > 0) {
      setTimeout(() => attempt(left - 1), 500);
      return;
    }
    if (phase === "signedIn") void useParty.getState().join(code);
    else useParty.getState().showJoin(true, code);
  };
  attempt(20);
}

function showInvite(invite: { code: string; name: string; title: string | null }): void {
  if (useParty.getState().code === invite.code) return;
  const text = invite.title ? t("party.invite.withTitle", { name: invite.name, title: invite.title }) : t("party.invite.plain", { name: invite.name });
  void import("./inbox").then(({ useInbox }) => useInbox.getState().add({ kind: "room", title: text, body: t("party.invite.body"), link: `room:${invite.code}` }));
  useUi.getState().toast(text, "info", { label: t("party.invite.join"), run: () => void useParty.getState().join(invite.code) });
}

export function describeMedia(media: PartyMedia): string {
  if (media.type === "tv" && media.season !== undefined && media.episode !== undefined) return `${media.title} · ${t("title.episodeShort", { season: media.season, episode: media.episode })}`;
  return media.title;
}

export function whenLive(timeoutMs = 15_000): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      const phase = useParty.getState().phase;
      if (phase === "live") return true;
      if (phase === "idle") return false;
      return null;
    };
    const first = check();
    if (first !== null) {
      resolve(first);
      return;
    }
    const timer = setTimeout(() => {
      stop();
      resolve(false);
    }, timeoutMs);
    const stop = useParty.subscribe(() => {
      const result = check();
      if (result === null) return;
      clearTimeout(timer);
      stop();
      resolve(result);
    });
  });
}
