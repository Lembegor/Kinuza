import { isDesktop, personalWritesAllowed } from "./backend";

export interface Account {
  id: number;
  name: string;
  email: string;
  code: string;
  avatar: string | null;
  showActivity: boolean;
  invisible: boolean;
  created: number;
}

export interface Watching {
  type: "movie" | "tv";
  id: number;
  title: string;
  poster: string | null;
  season?: number;
  episode?: number;
}

export interface Friend {
  id: number;
  name: string;
  avatar: string | null;
  online: boolean;
  lastSeen: number | null;
  watching: Watching | null;
  room?: { code: string; title: string | null; count: number } | null;
}

export interface FeedWatching {
  key: string;
  name: string;
  poster: string | null;
  movie: boolean;
  share: number;
  watched: number;
  total: number;
}

export interface FeedRecent {
  key: string;
  name: string;
  poster: string | null;
  at: number | null;
  movie: boolean;
  finished: boolean;
  rating: number | null;
  episodes: number;
  last: { season: number | null; episode: number | null } | null;
}

export interface FeedEntry {
  friend: Friend;
  updated: number;
  watching: FeedWatching[];
  recent: FeedRecent[];
}

export interface PartyInvite {
  code: string;
  from: number;
  name: string;
  avatar: string | null;
  title: string | null;
  at: number;
}

export interface Person {
  id: number;
  name: string;
  avatar: string | null;
  at: number;
}

export interface Social {
  friends: Friend[];
  incoming: Person[];
  outgoing: Person[];
  backupRevision: number;
  online?: number;
}

export type Relation = "none" | "friend" | "incoming" | "outgoing" | "self";

export interface FoundPerson {
  id: number;
  name: string;
  avatar: string | null;
  relation: Relation;
}

export interface FriendCardAnswer {
  friend: Friend;
  hidden: boolean;
  card: unknown;
  updated: number | null;
}

export interface AccountStatus {
  signedIn: boolean;
  base: string;
}

export interface SignInAnswer {
  account: Account;
  created: boolean;
}

export interface BackupPull {
  revision: number;
  text: string | null;
}

export type AccountChange = Partial<Pick<Account, "name" | "showActivity" | "invisible">> & { avatar?: string | null };

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!personalWritesAllowed() && command !== "account_online") throw new Error("profile_switching");
  if (isDesktop) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }
  const { mockInvoke } = await import("./backend.mock");
  return mockInvoke(command, args) as Promise<T>;
}

function request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown, query?: [string, string][]): Promise<T> {
  return call<T>("account_call", { method, path, body: body ?? null, query: query ?? null });
}

export const accountApi = {
  status: () => call<AccountStatus>("account_status"),
  online: () => call<number | null>("account_online"),
  signIn: () => call<SignInAnswer>("account_sign_in"),
  cancelSignIn: () => call<void>("account_cancel_sign_in"),
  forget: () => call<void>("account_forget"),
  me: () => request<Account>("GET", "me"),
  update: (change: AccountChange) => request<Account>("PATCH", "me", change),
  remove: () => request<{ ok: boolean }>("DELETE", "me"),
  signOut: () => request<{ ok: boolean }>("POST", "auth/signout"),
  signOutEverywhere: () => request<{ ok: boolean }>("POST", "auth/signout-all"),
  presence: (watching: Watching | null) => request<Social>("POST", "presence", { watching }),
  offline: () => request<{ ok: boolean }>("POST", "presence", { state: "offline" }),
  lookup: (code: string) => request<{ id: number; name: string; avatar: string | null; self: boolean }>("GET", "friends/lookup", undefined, [["code", code]]),
  addFriend: (code: string) => request<Social & { result: "sent" | "friends"; id: number }>("POST", "friends/request", { code }),
  addFriendById: (id: number) => request<Social & { result: "sent" | "friends"; id: number }>("POST", "friends/request", { id }),
  search: (query: string) => request<{ people: FoundPerson[] }>("GET", "friends/search", undefined, [["q", query]]),
  friendCard: (id: number) => request<FriendCardAnswer>("GET", "friends/card", undefined, [["id", String(id)]]),
  friendsFeed: () => request<{ friends: FeedEntry[] }>("GET", "friends/feed"),
  putCard: (card: unknown) => request<{ ok: boolean }>("PUT", "me/card", card),
  accept: (id: number) => request<Social>("POST", "friends/accept", { id }),
  decline: (id: number) => request<Social>("POST", "friends/decline", { id }),
  cancel: (id: number) => request<Social>("POST", "friends/cancel", { id }),
  removeFriend: (id: number) => request<Social>("POST", "friends/remove", { id }),
  partyTicket: () => request<{ ticket: string }>("POST", "party/ticket"),
  partyWait: () => request<{ invites: PartyInvite[] }>("GET", "party/wait"),
  pull: (known: number) => call<BackupPull>("account_sync_pull", { known }),
  push: (revision: number, text: string) => call<number>("account_sync_push", { revision, text }),
};

export const friendCodeLength = 8;

export function formatFriendCode(code: string): string {
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

export function cleanFriendCode(text: string): string {
  const fromLink = /\/f\/([A-Za-z0-9-]+)/.exec(text)?.[1] ?? text;
  return fromLink.toUpperCase().replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g, "").slice(0, friendCodeLength);
}

export function inviteLink(code: string): string {
  return `https://kinuza.channeluza.com/f/${code}`;
}
