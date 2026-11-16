import { create } from "zustand";
import { accountApi, type Account, type AccountChange, type Friend, type Social, type Watching } from "../lib/accountApi";
import { accountDataVersion, parseAccountData } from "../lib/account";
import { isAdultTitle } from "../lib/adultTitles";
import { backend, describeError } from "../lib/backend";
import { t } from "../lib/i18n";
import { report } from "../lib/journal";
import { beforeAppClose } from "../lib/lifecycle";
import { addActivity, onActivityChange, readActivity, type ActivityEvent } from "./activity";
import { useInbox } from "./inbox";
import { useLibrary } from "./library";
import { useProfile } from "./profile";
import { useSettings } from "./settings";
import { useUi } from "./ui";

const metaStore = "cloud-sync";
const backupMarker = "kinuza-backup";
const syncDelayMs = 45_000;
const pushGapMs = 5 * 60_000;
const afterPlayerMs = 8000;
const closeWaitMs = 5000;
const syncEveryMs = 10 * 60_000;
const presenceEveryMs = 60_000;
const presenceSoonMs = 2500;
const profileDelayMs = 3000;
const pushAttempts = 3;
const serverAvatarSize = 160;
const deviceSettings = ["downloadDir", "handleLinks", "linksPrompted", "loaded", "load", "patch", "version", "volume", "muted"];

export type AccountPhase = "unknown" | "signedOut" | "signingIn" | "signedIn";

export interface SyncInfo {
  state: "idle" | "syncing" | "error";
  at: number | null;
  error: string | null;
}

interface SyncMeta {
  userId: number;
  revision: number;
  hash: string;
  at: number | null;
  avatarHash: string;
  name: string;
}

interface AccountState {
  phase: AccountPhase;
  account: Account | null;
  base: string;
  sync: SyncInfo;
  social: Social | null;
  init: () => Promise<void>;
  signIn: () => Promise<void>;
  cancelSignIn: () => void;
  signOut: (everywhere?: boolean) => Promise<void>;
  deleteAccount: () => Promise<void>;
  update: (change: AccountChange) => Promise<void>;
  syncNow: () => Promise<void>;
  refreshSocial: () => Promise<void>;
  applySocial: (social: Social) => void;
}

let meta: SyncMeta = { userId: 0, revision: 0, hash: "", at: null, avatarHash: "", name: "" };
let syncing = false;
let syncAgain = false;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncInterval: ReturnType<typeof setInterval> | undefined;
let lastPushAt = 0;
let syncDueAt = Infinity;
let presenceTimer: ReturnType<typeof setTimeout> | undefined;
let profileTimer: ReturnType<typeof setTimeout> | undefined;
let lastWatchingKey = "";
let knownIncoming: Set<number> | null = null;
let knownOutgoing = new Set<number>();
let started = false;
const stops: (() => void)[] = [];

export function hashOf(text: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return (4294967296 * (2097151 & second) + (first >>> 0)).toString(36) + text.length.toString(36);
}

async function loadMeta(): Promise<void> {
  try {
    const document = await backend.storeGet(metaStore);
    const parsed = document ? (JSON.parse(document.text) as Partial<SyncMeta>) : {};
    meta = {
      userId: Number(parsed.userId) || 0,
      revision: Number(parsed.revision) || 0,
      hash: typeof parsed.hash === "string" ? parsed.hash : "",
      at: typeof parsed.at === "number" ? parsed.at : null,
      avatarHash: typeof parsed.avatarHash === "string" ? parsed.avatarHash : "",
      name: typeof parsed.name === "string" ? parsed.name : "",
    };
  } catch {
    meta = { userId: 0, revision: 0, hash: "", at: null, avatarHash: "", name: "" };
  }
}

function saveMeta(): void {
  void backend.storeSet(metaStore, JSON.stringify(meta)).catch(() => undefined);
}

function portableSettings(): Record<string, unknown> {
  const settings = useSettings.getState() as unknown as Record<string, unknown>;
  return Object.fromEntries(Object.entries(settings).filter(([key, value]) => !deviceSettings.includes(key) && typeof value !== "function"));
}

async function backupText(): Promise<string> {
  return JSON.stringify({
    app: backupMarker,
    version: 1,
    account: useLibrary.getState().exportAccountData(),
    profile: useProfile.getState().exportProfile(),
    activity: await readActivity(),
    settings: portableSettings(),
  });
}

function libraryReady(): boolean {
  const library = useLibrary.getState();
  return library.loaded && !library.unreadable && useProfile.getState().loaded && useSettings.getState().loaded;
}

function freshDevice(): boolean {
  const library = useLibrary.getState();
  return Object.keys(library.tracked).length === 0 && Object.keys(library.progress).length === 0;
}

function newerHere<T extends { updatedAt?: number }>(ours: Record<string, T> | undefined, theirs: Record<string, T> | undefined): boolean {
  const cloud = theirs ?? {};
  return Object.entries(ours ?? {}).some(([key, item]) => !cloud[key] || (item.updatedAt ?? 0) > (cloud[key].updatedAt ?? 0));
}

async function cloudIsBehind(text: string): Promise<boolean> {
  try {
    const backup = JSON.parse(text) as Record<string, unknown>;
    const parsed = parseAccountData(backup.account);
    if (!parsed) return true;
    const ours = useLibrary.getState().exportAccountData();
    const theirs = parsed.data;
    const removedNewer = Object.entries(ours.removed).some(([key, at]) => at > (theirs.removed[key] ?? 0));
    const profile = backup.profile as { updatedAt?: number } | undefined;
    const profileNewer = useProfile.getState().updatedAt > (profile?.updatedAt ?? 0);
    const cloudEvents = new Set((Array.isArray(backup.activity) ? (backup.activity as ActivityEvent[]) : []).map((event) => event?.id));
    const eventsMissing = (await readActivity()).some((event) => !cloudEvents.has(event.id));
    return (
      newerHere(ours.tracked, theirs.tracked) ||
      newerHere(ours.progress, theirs.progress) ||
      newerHere(ours.preferences, theirs.preferences) ||
      newerHere(ours.dismissed, theirs.dismissed) ||
      removedNewer ||
      profileNewer ||
      eventsMissing
    );
  } catch {
    return true;
  }
}

async function absorb(text: string, applySettings: boolean): Promise<void> {
  const backup = JSON.parse(text) as Record<string, unknown>;
  if (backup.app !== backupMarker) throw new Error("sync_damaged");
  const parsed = parseAccountData(backup.account);
  if (!parsed) throw new Error("sync_damaged");
  if (parsed.data.version > accountDataVersion) throw new Error("sync_newer");
  useLibrary.getState().mergeAccountData(parsed.data);
  if (backup.profile) useProfile.getState().mergeProfile(backup.profile);
  if (Array.isArray(backup.activity)) {
    const removed = useLibrary.getState().removed;
    const events = (backup.activity as ActivityEvent[]).filter(
      (event) => event && typeof event === "object" && typeof event.id === "string" && !removed[`activity:${event.id}`],
    );
    await addActivity(events);
  }
  if (applySettings && backup.settings && typeof backup.settings === "object") {
    const incoming = Object.fromEntries(Object.entries(backup.settings as Record<string, unknown>).filter(([key]) => !deviceSettings.includes(key)));
    useSettings.getState().patch(incoming);
  }
}

function conflictRevision(error: unknown): number | null {
  const found = /^sync_conflict:(\d+)$/.exec(String(error));
  return found ? Number(found[1]) : null;
}

function scheduleSync(delay = syncDelayMs, urgent = false): void {
  if (useAccount.getState().phase !== "signedIn") return;
  const wait = urgent ? delay : Math.max(delay, lastPushAt + pushGapMs - Date.now());
  const due = Date.now() + wait;
  if (syncTimer !== undefined && syncDueAt <= due) return;
  clearTimeout(syncTimer);
  syncDueAt = due;
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    syncDueAt = Infinity;
    void runSync();
  }, wait);
}

async function runSync(): Promise<void> {
  const state = useAccount.getState();
  if (state.phase !== "signedIn" || !state.account) return;
  if (!libraryReady()) {
    scheduleSync(5000, true);
    return;
  }
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  useAccount.setState({ sync: { ...state.sync, state: "syncing", error: null } });
  let settled = false;
  try {
    for (let attempt = 0; attempt < pushAttempts && !settled; attempt++) {
      const before = await backupText();
      const pulled = await accountApi.pull(meta.revision);
      const dirty = hashOf(before) !== meta.hash || pulled.revision < meta.revision || pulled.revision === 0;
      let pushed = false;
      if (pulled.text !== null) {
        const behind = await cloudIsBehind(pulled.text);
        await absorb(pulled.text, meta.revision === 0 && freshDevice());
        meta.revision = pulled.revision;
        const after = await backupText();
        if (!dirty && !behind) {
          meta.hash = hashOf(after);
          settled = true;
          break;
        }
        try {
          meta.revision = await accountApi.push(meta.revision, after);
          meta.hash = hashOf(after);
          lastPushAt = Date.now();
          pushed = true;
        } catch (error) {
          const current = conflictRevision(error);
          if (current === null) throw error;
          continue;
        }
      } else {
        meta.revision = pulled.revision;
        if (!dirty) {
          settled = true;
          break;
        }
        try {
          meta.revision = await accountApi.push(meta.revision, before);
          meta.hash = hashOf(before);
          lastPushAt = Date.now();
          pushed = true;
        } catch (error) {
          const current = conflictRevision(error);
          if (current === null) throw error;
          continue;
        }
      }
      if (pushed) settled = true;
    }
    saveMeta();
    if (!settled) throw new Error("sync_busy");
    meta.at = Date.now();
    saveMeta();
    useAccount.setState({ sync: { state: "idle", at: meta.at, error: null } });
  } catch (error) {
    const code = String(error instanceof Error ? error.message : error);
    if (code === "account_signed_out") {
      signedOutLocally();
      return;
    }
    if (code === "sync_busy") {
      useAccount.setState({ sync: { state: "idle", at: meta.at, error: null } });
      scheduleSync(15_000, true);
      return;
    }
    report("account", "journal.account.sync", error);
    useAccount.setState({ sync: { state: "error", at: meta.at, error: code } });
    scheduleSync(5 * 60_000, true);
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      scheduleSync(2000, true);
    }
  }
}

function watchingNow(): Watching | null {
  const session = useUi.getState().player;
  if (!session || isAdultTitle(session.title.type, session.title.id)) return null;
  return {
    type: session.title.type,
    id: session.title.id,
    title: session.title.title,
    poster: session.title.poster ?? null,
    ...(session.title.type === "tv" && session.season !== undefined ? { season: session.season } : {}),
    ...(session.title.type === "tv" && session.episode !== undefined ? { episode: session.episode } : {}),
  };
}

function schedulePresence(delay: number): void {
  clearTimeout(presenceTimer);
  if (useAccount.getState().phase !== "signedIn") return;
  presenceTimer = setTimeout(() => void sendPresence(), delay);
}

async function sendPresence(): Promise<void> {
  if (useAccount.getState().phase !== "signedIn") return;
  try {
    const watching = watchingNow();
    lastWatchingKey = watching ? `${watching.type}:${watching.id}:${watching.season ?? ""}:${watching.episode ?? ""}` : "";
    const social = await accountApi.presence(watching);
    useAccount.getState().applySocial(social);
    if (!useAccount.getState().account?.code) void refreshAccount();
    if (social.backupRevision > meta.revision) scheduleSync(3000, true);
  } catch (error) {
    if (String(error).includes("account_signed_out")) {
      signedOutLocally();
      return;
    }
  }
  schedulePresence(presenceEveryMs);
}

function notifySocial(social: Social): void {
  const names = new Map(social.friends.map((friend) => [friend.id, friend.name]));
  if (knownIncoming) {
    for (const person of social.incoming) {
      if (knownIncoming.has(person.id)) continue;
      const name = person.name || t("friends.someone");
      useInbox.getState().add({ kind: "friend", title: t("friends.inbox.request", { name }), body: t("friends.inbox.requestBody"), link: "/profile/friends" });
      useUi.getState().toast(t("friends.toast.request", { name }), "info");
    }
    for (const id of knownOutgoing) {
      if (!social.outgoing.some((person) => person.id === id) && names.has(id)) {
        const name = names.get(id) || t("friends.someone");
        useInbox.getState().add({ kind: "friend", title: t("friends.inbox.accepted", { name }), body: "", link: "/profile/friends" });
        useUi.getState().toast(t("friends.toast.accepted", { name }), "success");
      }
    }
  }
  knownIncoming = new Set(social.incoming.map((person) => person.id));
  knownOutgoing = new Set(social.outgoing.map((person) => person.id));
}

async function scaledAvatar(source: string): Promise<string | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = serverAvatarSize;
      canvas.height = serverAvatarSize;
      const context = canvas.getContext("2d");
      if (!context) {
        resolve(null);
        return;
      }
      const side = Math.min(image.width, image.height);
      context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, serverAvatarSize, serverAvatarSize);
      resolve(canvas.toDataURL("image/jpeg", 0.82));
    };
    image.onerror = () => resolve(null);
    image.src = source;
  });
}

async function pushProfile(): Promise<void> {
  const state = useAccount.getState();
  if (state.phase !== "signedIn" || !state.account) return;
  const profile = useProfile.getState();
  if (!profile.loaded) return;
  const change: AccountChange = {};
  const name = profile.name.trim();
  if (name && name !== state.account.name) change.name = name;
  const avatarHash = profile.avatar ? hashOf(profile.avatar) : "";
  if (avatarHash !== meta.avatarHash) {
    change.avatar = profile.avatar ? await scaledAvatar(profile.avatar) : null;
    if (profile.avatar && !change.avatar) delete change.avatar;
  }
  if (Object.keys(change).length === 0) return;
  try {
    const account = await accountApi.update(change);
    if ("avatar" in change) meta.avatarHash = avatarHash;
    saveMeta();
    useAccount.setState({ account });
  } catch (error) {
    report("account", "journal.account.profile", error);
  }
}

async function refreshAccount(): Promise<void> {
  try {
    const account = await accountApi.me();
    if (account.id !== meta.userId) {
      meta = { userId: account.id, revision: 0, hash: "", at: null, avatarHash: "", name: account.name };
    }
    meta.name = account.name;
    saveMeta();
    useAccount.setState({ account });
    scheduleSync(1500, true);
  } catch {
    return;
  }
}

function signedOutLocally(): void {
  stopLoops();
  knownIncoming = null;
  knownOutgoing = new Set();
  useAccount.setState({ phase: "signedOut", account: null, social: null, sync: { state: "idle", at: null, error: null } });
}

function stopLoops(): void {
  clearTimeout(syncTimer);
  syncTimer = undefined;
  syncDueAt = Infinity;
  clearTimeout(presenceTimer);
  clearTimeout(profileTimer);
  clearInterval(syncInterval);
  while (stops.length > 0) stops.pop()?.();
}

function startLoops(): void {
  stopLoops();
  stops.push(
    useLibrary.subscribe((next, previous) => {
      if (next.tracked !== previous.tracked || next.progress !== previous.progress || next.preferences !== previous.preferences || next.dismissed !== previous.dismissed || next.removed !== previous.removed) scheduleSync();
    }),
    useProfile.subscribe((next, previous) => {
      if (next.updatedAt !== previous.updatedAt) scheduleSync();
      if (next.name !== previous.name || next.avatar !== previous.avatar) {
        clearTimeout(profileTimer);
        profileTimer = setTimeout(() => void pushProfile(), profileDelayMs);
      }
    }),
    onActivityChange(() => scheduleSync()),
    useUi.subscribe((next, previous) => {
      if (next.player === previous.player) return;
      if (!next.player && previous.player) scheduleSync(afterPlayerMs, true);
      const watching = watchingNow();
      const key = watching ? `${watching.type}:${watching.id}:${watching.season ?? ""}:${watching.episode ?? ""}` : "";
      if (key !== lastWatchingKey) schedulePresence(presenceSoonMs);
    }),
    beforeAppClose(async () => {
      if (useAccount.getState().phase !== "signedIn") return;
      clearTimeout(syncTimer);
      syncTimer = undefined;
      syncDueAt = Infinity;
      const last = async () => {
        while (syncing) await new Promise((resolve) => setTimeout(resolve, 100));
        syncAgain = false;
        await runSync();
      };
      await Promise.race([last(), new Promise((resolve) => setTimeout(resolve, closeWaitMs))]);
    }),
  );
  syncInterval = setInterval(() => scheduleSync(0), syncEveryMs);
  schedulePresence(0);
  scheduleSync(1500, true);
  profileTimer = setTimeout(() => void pushProfile(), profileDelayMs);
}

async function adopt(account: Account, created: boolean): Promise<void> {
  await loadMeta();
  if (meta.userId !== account.id) meta = { userId: account.id, revision: 0, hash: "", at: null, avatarHash: "", name: account.name };
  saveMeta();
  useAccount.setState({ phase: "signedIn", account });
  const profile = useProfile.getState();
  if (profile.loaded && !profile.name.trim() && account.name) profile.patch({ name: account.name });
  if (created) void backend.appLog("account: a new account was made");
  startLoops();
}

export const useAccount = create<AccountState>((set, get) => ({
  phase: "unknown",
  account: null,
  base: "",
  sync: { state: "idle", at: null, error: null },
  social: null,

  async init() {
    if (started) return;
    started = true;
    try {
      const status = await accountApi.status();
      set({ base: status.base });
      if (!status.signedIn) {
        set({ phase: "signedOut" });
        return;
      }
      await loadMeta();
      set({ sync: { state: "idle", at: meta.at, error: null } });
      try {
        const account = await accountApi.me();
        await adopt(account, false);
      } catch (error) {
        if (String(error).includes("account_signed_out")) {
          set({ phase: "signedOut" });
          return;
        }
        set({ phase: "signedIn", account: meta.userId ? { id: meta.userId, name: meta.name, email: "", code: "", avatar: null, showActivity: true, invisible: false, created: 0 } : null });
        startLoops();
      }
    } catch {
      set({ phase: "signedOut" });
    }
  },

  async signIn() {
    if (get().phase === "signingIn") return;
    set({ phase: "signingIn" });
    try {
      const answer = await accountApi.signIn();
      const status = await accountApi.status();
      set({ base: status.base });
      await adopt(answer.account, answer.created);
      useUi.getState().toast(t("account.toast.signedIn", { name: answer.account.name || answer.account.email }), "success");
    } catch (error) {
      set({ phase: "signedOut" });
      const code = String(error instanceof Error ? error.message : error);
      if (code !== "account_cancelled") useUi.getState().toast(describeError(error), "error");
    }
  },

  cancelSignIn() {
    void accountApi.cancelSignIn();
  },

  async signOut(everywhere = false) {
    try {
      await runSync();
      await accountApi.offline().catch(() => undefined);
      await (everywhere ? accountApi.signOutEverywhere() : accountApi.signOut());
    } catch {
      await accountApi.forget();
    }
    signedOutLocally();
    useUi.getState().toast(t("account.toast.signedOut"), "info");
  },

  async deleteAccount() {
    try {
      await accountApi.remove();
      meta = { userId: 0, revision: 0, hash: "", at: null, avatarHash: "", name: "" };
      saveMeta();
      signedOutLocally();
      useUi.getState().toast(t("account.toast.deleted"), "info");
    } catch (error) {
      useUi.getState().toast(describeError(error), "error");
    }
  },

  async update(change) {
    try {
      const account = await accountApi.update(change);
      set({ account });
      if (change.invisible !== undefined || change.showActivity !== undefined) schedulePresence(500);
    } catch (error) {
      useUi.getState().toast(describeError(error), "error");
    }
  },

  async syncNow() {
    await runSync();
  },

  async refreshSocial() {
    await sendPresence();
  },

  applySocial(social) {
    notifySocial(social);
    set({ social });
  },
}));

export function friendStatus(friend: Friend, locale: string): string {
  if (friend.watching) {
    const episode = friend.watching.season !== undefined && friend.watching.episode !== undefined ? ` · ${t("title.episodeShort", { season: friend.watching.season, episode: friend.watching.episode })}` : "";
    return `${t("friends.status.watching")} ${friend.watching.title}${episode}`;
  }
  if (friend.online) return t("friends.status.online");
  if (!friend.lastSeen) return t("friends.status.offline");
  const minutes = Math.max(1, Math.round((Date.now() / 1000 - friend.lastSeen) / 60));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const ago =
    minutes < 60 ? format.format(-minutes, "minute") : minutes < 60 * 24 ? format.format(-Math.round(minutes / 60), "hour") : format.format(-Math.round(minutes / 1440), "day");
  return t("friends.status.seen", { ago });
}

export function avatarUrl(path: string | null, base: string): string | null {
  return path && base ? `${base}${path}` : null;
}
