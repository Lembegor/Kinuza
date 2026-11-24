import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { accountApi, type FeedEntry, type Friend } from "../lib/accountApi";
import { isAdultTitle } from "../lib/adultTitles";
import { useAccount } from "./account";

const staleMs = 5 * 60_000;
const itemLimit = 20;
const unknownAgeMs = 3 * 86_400_000;

export type MarkKind = "live" | "rated" | "finished" | "watched" | "watching";

export interface FriendMark {
  friend: Friend;
  kind: MarkKind;
  at: number;
  rating: number | null;
  season: number | null;
  episode: number | null;
  watched: number;
  total: number;
}

export interface FriendsItem {
  type: "movie" | "tv";
  id: number;
  key: string;
  title: string;
  poster: string | null;
  marks: FriendMark[];
  live: boolean;
  at: number;
}

interface FeedState {
  entries: FeedEntry[];
  at: number;
  loading: boolean;
  refresh: (force?: boolean) => Promise<void>;
}

export const useFriendsFeed = create<FeedState>((set, get) => ({
  entries: [],
  at: 0,
  loading: false,
  async refresh(force = false) {
    if (useAccount.getState().phase !== "signedIn") return;
    const { loading, at } = get();
    if (loading || (!force && Date.now() - at < staleMs)) return;
    set({ loading: true });
    try {
      const answer = await accountApi.friendsFeed();
      set({ entries: Array.isArray(answer.friends) ? answer.friends : [], at: Date.now() });
    } catch {
      set({ at: Date.now() });
    } finally {
      set({ loading: false });
    }
  },
}));

useAccount.subscribe((state, previous) => {
  if (state.phase !== previous.phase && state.phase !== "signedIn") useFriendsFeed.setState({ entries: [], at: 0 });
});

const rank: Record<MarkKind, number> = { live: 5, rated: 4, finished: 3, watched: 2, watching: 1 };

function parseKey(key: string): { type: "movie" | "tv"; id: number } | null {
  const [type, raw] = key.split(":");
  const id = Number(raw);
  if ((type !== "movie" && type !== "tv") || !Number.isFinite(id) || id <= 0) return null;
  return isAdultTitle(type, id) ? null : { type, id };
}

export function buildFriendsItems(entries: FeedEntry[], live: Friend[], now: number): FriendsItem[] {
  const items = new Map<string, FriendsItem>();
  const add = (key: string, title: string, poster: string | null, mark: FriendMark) => {
    const ref = parseKey(key);
    if (!ref) return;
    const item = items.get(key) ?? { ...ref, key, title, poster, marks: [], live: false, at: 0 };
    if (!item.poster && poster) item.poster = poster;
    const index = item.marks.findIndex((other) => other.friend.id === mark.friend.id);
    if (index === -1) item.marks.push(mark);
    else if (rank[mark.kind] > rank[item.marks[index].kind] || (rank[mark.kind] === rank[item.marks[index].kind] && mark.at > item.marks[index].at)) item.marks[index] = mark;
    item.live ||= mark.kind === "live";
    item.at = Math.max(item.at, mark.at);
    items.set(key, item);
  };
  const blank = { rating: null, season: null, episode: null, watched: 0, total: 0 };

  for (const friend of live) {
    const watching = friend.watching;
    if (!watching) continue;
    add(`${watching.type}:${watching.id}`, watching.title, watching.poster, {
      ...blank,
      friend,
      kind: "live",
      at: now,
      season: watching.season ?? null,
      episode: watching.episode ?? null,
    });
  }

  for (const entry of entries) {
    const friend = live.find((item) => item.id === entry.friend.id) ?? entry.friend;
    let newest = 0;
    for (const item of entry.recent) {
      const at = item.at ?? 0;
      newest = Math.max(newest, at);
      const kind: MarkKind = item.rating ? "rated" : item.finished ? "finished" : "watched";
      add(item.key, item.name, item.poster, {
        ...blank,
        friend,
        kind,
        at,
        rating: item.rating,
        season: item.last?.season ?? null,
        episode: item.last?.episode ?? null,
        watched: item.episodes,
      });
    }
    for (const item of entry.watching) {
      const seen = entry.recent.find((recent) => recent.key === item.key)?.at;
      add(item.key, item.name, item.poster, {
        ...blank,
        friend,
        kind: "watching",
        at: seen ?? (newest || now) - unknownAgeMs,
        watched: item.watched,
        total: item.total,
      });
    }
  }

  return [...items.values()]
    .map((item) => ({ ...item, marks: [...item.marks].sort((a, b) => rank[b.kind] - rank[a.kind] || b.at - a.at) }))
    .sort((a, b) => Number(b.live) - Number(a.live) || b.at - a.at)
    .slice(0, itemLimit);
}

const noFriends: Friend[] = [];

export function useFriendsItems(): FriendsItem[] {
  const phase = useAccount((state) => state.phase);
  const live = useAccount((state) => state.social?.friends ?? noFriends);
  const entries = useFriendsFeed((state) => state.entries);
  const refresh = useFriendsFeed((state) => state.refresh);
  const liveCount = live.length;
  useEffect(() => {
    if (phase !== "signedIn" || liveCount === 0) return;
    void refresh();
    const timer = setInterval(() => void refresh(), staleMs);
    return () => clearInterval(timer);
  }, [phase, liveCount, refresh]);
  return useMemo(() => (phase === "signedIn" ? buildFriendsItems(entries, live, Date.now()) : []), [phase, entries, live]);
}
