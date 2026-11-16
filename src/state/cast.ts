import { create } from "zustand";
import { backend, describeError, type CastDevice, type CastRequest, type CastStatus, type CastSubtitleChoice, type MediaTracks } from "../lib/backend";
import { t } from "../lib/i18n";
import { report } from "../lib/journal";
import { beforeAppClose } from "../lib/lifecycle";
import { sortSources } from "../lib/sources";
import { recordActivity, titleOf } from "./activity";
import { unitKey, useLibrary, type Source } from "./library";
import { useSettings } from "./settings";
import { useUi, type PlayerSession } from "./ui";

export type CastPhase = "idle" | "picking" | "starting" | "casting" | "failed";

export interface CastJob {
  session: PlayerSession;
  source: Source;
  start: number;
  duration: number;
  audio: number | null;
  subtitle: CastSubtitleChoice | null;
  subtitleLabel: string;
  tracks: MediaTracks | null;
  burn: boolean;
}

interface CastStore {
  phase: CastPhase;
  devices: CastDevice[];
  scanning: boolean;
  scanned: boolean;
  device: CastDevice | null;
  job: CastJob | null;
  level: number;
  status: CastStatus | null;
  position: number;
  playing: boolean;
  busy: string | null;
  error: string | null;
  expanded: boolean;
  nextIn: number | null;
  pick: (job: CastJob) => void;
  closePicker: () => void;
  scan: () => Promise<void>;
  choose: (device: CastDevice) => Promise<void>;
  togglePause: () => Promise<void>;
  seek: (position: number) => Promise<void>;
  setVolume: (value: number) => Promise<void>;
  chooseAudio: (index: number) => Promise<void>;
  chooseSubtitle: (choice: CastSubtitleChoice | null, label: string) => Promise<void>;
  setBurn: (burn: boolean) => Promise<void>;
  setLevel: (level: number) => Promise<void>;
  backToComputer: () => Promise<void>;
  stop: () => Promise<void>;
  playNext: () => Promise<void>;
  cancelNext: () => void;
  setExpanded: (expanded: boolean) => void;
}

const levelsKey = "kinuza-cast-levels";
const lastDeviceKey = "kinuza-cast-device";
const pollMs = 1000;
const startGraceMs = 25_000;
const settledMs = 6000;
const saveEveryMs = 10_000;
const endSlackSeconds = 25;
const nextCountdownSeconds = 10;
const maxLevel = 3;
const seekDelayMs = 350;

let pollTimer: ReturnType<typeof setInterval> | undefined;
let nextTimer: ReturnType<typeof setInterval> | undefined;
let seekTimer: ReturnType<typeof setTimeout> | undefined;
let startedAt = 0;
let playingSince = 0;
let everPlayed = false;
let settled = false;
let lastSaveAt = 0;
let playedSeconds = 0;
let lastTick = 0;
let sessionStartedAt = 0;
let removeCloseTask: (() => void) | null = null;
let generation = 0;

function readLevels(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(levelsKey) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function rememberLevel(device: string, level: number): void {
  try {
    localStorage.setItem(levelsKey, JSON.stringify({ ...readLevels(), [device]: level }));
  } catch {
    return;
  }
}

export function lastDeviceId(): string {
  try {
    return localStorage.getItem(lastDeviceKey) ?? "";
  } catch {
    return "";
  }
}

function rememberDevice(id: string): void {
  try {
    localStorage.setItem(lastDeviceKey, id);
  } catch {
    return;
  }
}

function requestFor(job: CastJob, device: CastDevice, level: number, start: number): CastRequest {
  const audio = job.audio !== null ? job.tracks?.audio[job.audio] : job.tracks?.audio.find((track) => track.isDefault) ?? job.tracks?.audio[0];
  return {
    device: device.id,
    infoHash: job.source.infoHash,
    fileIndex: job.source.fileIndex,
    fileName: job.source.fileName,
    title: job.session.episode !== undefined ? `${job.session.title.title} · ${t("title.episodeShort", { season: job.session.season ?? 0, episode: job.session.episode })}` : job.session.title.title,
    start,
    duration: job.duration,
    audio: job.audio,
    audioCodec: audio?.codec ?? "",
    audioChannels: audio?.channels ?? "",
    videoCodec: job.tracks?.videoCodec ?? "",
    subtitle: job.subtitle,
    burn: job.burn,
    level,
  };
}

function saveProgress(force = false): void {
  const { job, position } = useCast.getState();
  if (!job || position < 1) return;
  if (!force && Date.now() - lastSaveAt < saveEveryMs) return;
  lastSaveAt = Date.now();
  const length = job.duration > 0 ? job.duration : position;
  useLibrary.getState().setProgress(job.session.unitKey, {
    position,
    duration: length,
    updatedAt: Date.now(),
    title: job.session.title,
    season: job.session.season,
    episode: job.session.episode,
    episodeName: job.session.episodeName,
    played: Math.round(Math.min(length, playedSeconds)),
  });
}

function finishActivity(): void {
  const { job } = useCast.getState();
  if (!job || playedSeconds < 30) return;
  const saved = useLibrary.getState().progress[job.session.unitKey];
  recordActivity(
    "play",
    {
      unit: job.session.unitKey,
      title: titleOf(job.session.title),
      ...(job.session.season !== undefined ? { season: job.session.season, episode: job.session.episode } : {}),
      startedAt: sessionStartedAt,
      seconds: Math.round(playedSeconds),
      position: saved ? Math.round(saved.position) : undefined,
      duration: saved && saved.duration > 1 ? Math.round(saved.duration) : undefined,
      quality: job.source.quality,
      cast: true,
    },
    sessionStartedAt,
  );
  playedSeconds = 0;
}

function nextEpisodeOf(job: CastJob): { session: PlayerSession; source: Source } | null {
  const { session } = job;
  if (session.title.type !== "tv" || session.season === undefined || session.episode === undefined) return null;
  const sources = useLibrary.getState().sources;
  const candidates = [unitKey("tv", session.title.id, session.season, session.episode + 1), unitKey("tv", session.title.id, session.season + 1, 1)];
  for (const unit of candidates) {
    const list = sortSources(sources[unit] ?? []);
    if (list.length === 0) continue;
    const source = list.find((item) => item.infoHash === job.source.infoHash) ?? list[0];
    const [, , season, episode] = unit.split(":");
    return { session: { title: session.title, unitKey: unit, season: Number(season), episode: Number(episode), preferredSourceId: source.id }, source };
  }
  return null;
}

async function tracksFor(source: Source): Promise<MediaTracks | null> {
  try {
    return await backend.mediaTracks(source.infoHash, source.fileIndex);
  } catch {
    return null;
  }
}

function sameVoice(previous: MediaTracks | null, index: number | null, next: MediaTracks | null): number | null {
  if (!next || next.audio.length === 0) return null;
  const wanted = index !== null ? previous?.audio[index] : undefined;
  if (!wanted) return null;
  const exact = next.audio.find((track) => track.language === wanted.language && track.title === wanted.title);
  const language = next.audio.find((track) => track.language === wanted.language);
  return (exact ?? language)?.index ?? null;
}

function stopPolling(): void {
  clearInterval(pollTimer);
  pollTimer = undefined;
}

function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(() => void poll(), pollMs);
}

async function poll(): Promise<void> {
  const store = useCast.getState();
  if (store.phase !== "starting" && store.phase !== "casting") return;
  const mine = generation;
  let status: CastStatus;
  try {
    status = await backend.castStatus();
  } catch (error) {
    if (mine !== generation) return;
    if (Date.now() - startedAt > startGraceMs) useCast.setState({ error: describeError(error) });
    return;
  }
  if (mine !== generation || !status.active) return;
  const now = performance.now();
  const playing = status.state === "PLAYING";
  if (playing && lastTick) playedSeconds += Math.min(2, (now - lastTick) / 1000);
  lastTick = now;
  if (playing && !playingSince) playingSince = Date.now();
  if (!playing) playingSince = 0;
  if (playing) everPlayed = true;
  const job = store.job;
  useCast.setState({ status, position: Math.max(0, status.position), playing, error: null, phase: everPlayed ? "casting" : store.phase });
  if (playing && !settled && Date.now() - playingSince > settledMs && store.device) {
    settled = true;
    rememberLevel(store.device.id, store.level);
    void backend.appLog(`cast: playing on ${store.device.name} at level ${store.level}`);
  }
  if (playing) saveProgress();
  const stopped = status.state === "STOPPED" || status.state === "NO_MEDIA_PRESENT";
  if (stopped && everPlayed && job) {
    const length = job.duration;
    if (length > 0 && status.position >= length - endSlackSeconds) {
      ended();
      return;
    }
  }
  if (!everPlayed && Date.now() - startedAt > startGraceMs) {
    await escalate(t("cast.notice.noPicture"));
    return;
  }
  if (!everPlayed && stopped && Date.now() - startedAt > 6000) await escalate(t("cast.notice.refused"));
}

async function escalate(reason: string): Promise<void> {
  const store = useCast.getState();
  if (!store.job || !store.device) return;
  if (store.level >= maxLevel) {
    stopPolling();
    useCast.setState({ phase: "failed", error: t("cast.error.unsupported") });
    void backend.appLog(`cast: ${store.device.name} could not play even at level ${store.level}`);
    return;
  }
  const level = store.level + 1;
  void backend.appLog(`cast: ${store.device.name} showed nothing at level ${store.level} (${reason}), trying level ${level}`);
  useUi.getState().toast(t("cast.notice.tryingSafer"), "info");
  await launch(store.job, store.device, level, store.position || store.job.start);
}

function ended(): void {
  const { job } = useCast.getState();
  if (!job) return;
  saveProgress(true);
  const next = nextEpisodeOf(job);
  if (!next || !useSettings.getState().autoNextEpisode) {
    useCast.setState({ nextIn: null, playing: false });
    return;
  }
  let left = nextCountdownSeconds;
  useCast.setState({ nextIn: left });
  clearInterval(nextTimer);
  nextTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(nextTimer);
      useCast.setState({ nextIn: null });
      void useCast.getState().playNext();
      return;
    }
    useCast.setState({ nextIn: left });
  }, 1000);
}

async function launch(job: CastJob, device: CastDevice, level: number, start: number): Promise<void> {
  generation += 1;
  const mine = generation;
  startedAt = Date.now();
  everPlayed = false;
  settled = false;
  playingSince = 0;
  lastTick = 0;
  useCast.setState({ phase: "starting", job: { ...job, start }, device, level, position: start, playing: false, error: null, busy: null });
  try {
    const started = await backend.castStart(requestFor(job, device, level, start));
    if (mine !== generation) return;
    void backend.appLog(`cast: ${job.session.title.title} on ${device.name} level=${level} direct=${started.direct} from ${Math.round(start)}s`);
    startPolling();
  } catch (error) {
    if (mine !== generation) return;
    report("player", "journal.cast.start", error);
    const code = String(error instanceof Error ? error.message : error);
    if (code === "cast_refused" && level < maxLevel) {
      await launch(job, device, level + 1, start);
      return;
    }
    useCast.setState({ phase: "failed", error: describeError(error) });
  }
}

function startSession(): void {
  sessionStartedAt = Date.now();
  playedSeconds = 0;
  lastSaveAt = 0;
  removeCloseTask?.();
  removeCloseTask = beforeAppClose(async () => {
    saveProgress(true);
    finishActivity();
    await backend.castStop().catch(() => undefined);
  });
}

function endSession(): void {
  stopPolling();
  clearInterval(nextTimer);
  clearTimeout(seekTimer);
  removeCloseTask?.();
  removeCloseTask = null;
  generation += 1;
}

export const useCast = create<CastStore>((set, get) => ({
  phase: "idle",
  devices: [],
  scanning: false,
  scanned: false,
  device: null,
  job: null,
  level: 0,
  status: null,
  position: 0,
  playing: false,
  busy: null,
  error: null,
  expanded: true,
  nextIn: null,

  pick(job) {
    set({ phase: "picking", job, error: null });
    void get().scan();
  },

  closePicker() {
    if (get().phase === "picking") set({ phase: "idle", job: null });
  },

  async scan() {
    if (get().scanning) return;
    set({ scanning: true });
    try {
      const devices = await backend.castDevices();
      const last = lastDeviceId();
      devices.sort((a, b) => Number(b.id === last) - Number(a.id === last));
      set({ devices, scanned: true });
    } catch (error) {
      set({ error: describeError(error), scanned: true });
    } finally {
      set({ scanning: false });
    }
  },

  async choose(device) {
    const job = get().job;
    if (!job) return;
    rememberDevice(device.id);
    useUi.getState().closePlayer();
    void backend.holdOnline(job.source.infoHash).catch(() => undefined);
    startSession();
    set({ expanded: true, nextIn: null });
    await launch(job, device, readLevels()[device.id] ?? 0, job.start);
  },

  async togglePause() {
    const { playing, phase } = get();
    if (phase !== "casting") return;
    try {
      if (playing) {
        await backend.castPause();
        set({ playing: false });
      } else {
        await backend.castPlay();
        set({ playing: true });
      }
    } catch (error) {
      useUi.getState().toast(describeError(error), "error");
    }
  },

  async seek(position) {
    const { job, device, level } = get();
    if (!job || !device) return;
    const target = Math.max(0, job.duration > 0 ? Math.min(position, job.duration - 5) : position);
    set({ position: target, busy: "seek" });
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      void (async () => {
        saveProgress(true);
        const native = await backend.castSeekNative(target).catch(() => false);
        if (!native) await launch(job, device, level, target);
        else set({ busy: null });
      })();
    }, seekDelayMs);
  },

  async setVolume(value) {
    set((state) => ({ status: state.status ? { ...state.status, volume: value } : state.status }));
    await backend.castVolume(Math.round(value)).catch(() => undefined);
  },

  async chooseAudio(index) {
    const { job, device, level, position } = get();
    if (!job || !device || job.audio === index) return;
    await launch({ ...job, audio: index }, device, level, position);
  },

  async chooseSubtitle(choice, label) {
    const { job, device, level, position } = get();
    if (!job || !device) return;
    await launch({ ...job, subtitle: choice, subtitleLabel: label }, device, level, position);
  },

  async setBurn(burn) {
    const { job, device, level, position } = get();
    if (!job || !device || job.burn === burn) return;
    await launch({ ...job, burn }, device, level, position);
  },

  async setLevel(level) {
    const { job, device, position } = get();
    if (!job || !device) return;
    rememberLevel(device.id, level);
    await launch(job, device, level, position);
  },

  async backToComputer() {
    const { job } = get();
    if (!job) return;
    saveProgress(true);
    finishActivity();
    endSession();
    await backend.castStop().catch(() => undefined);
    set({ phase: "idle", status: null, playing: false, nextIn: null });
    useUi.getState().play({ ...job.session, preferredSourceId: job.source.id });
    set({ job: null, device: null });
  },

  async stop() {
    const { job } = get();
    saveProgress(true);
    finishActivity();
    endSession();
    await backend.castStop().catch(() => undefined);
    if (job) void backend.releaseOnline(job.source.infoHash).catch(() => undefined);
    set({ phase: "idle", job: null, device: null, status: null, playing: false, nextIn: null, error: null });
  },

  async playNext() {
    const { job, device, level } = get();
    if (!job || !device) return;
    clearInterval(nextTimer);
    set({ nextIn: null });
    const next = nextEpisodeOf(job);
    if (!next) return;
    saveProgress(true);
    finishActivity();
    sessionStartedAt = Date.now();
    const tracks = await tracksFor(next.source);
    const sameFile = next.source.infoHash === job.source.infoHash;
    const audio = sameFile ? job.audio : sameVoice(job.tracks, job.audio, tracks);
    const subtitle = sameFile && job.subtitle?.kind === "internal" ? job.subtitle : null;
    void backend.holdOnline(next.source.infoHash).catch(() => undefined);
    await launch(
      { ...job, session: next.session, source: next.source, start: 0, duration: tracks?.duration ?? 0, audio, tracks, subtitle, subtitleLabel: subtitle ? job.subtitleLabel : "" },
      device,
      level,
      0,
    );
  },

  cancelNext() {
    clearInterval(nextTimer);
    set({ nextIn: null });
  },

  setExpanded: (expanded) => set({ expanded }),
}));

export function hasNextEpisode(): boolean {
  const job = useCast.getState().job;
  return !!job && nextEpisodeOf(job) !== null;
}
