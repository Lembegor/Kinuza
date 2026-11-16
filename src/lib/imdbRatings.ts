import { useEffect, useRef, useState } from "react";
import { backend, isDesktop, type ImdbRating } from "./backend";
import { catalogRecord } from "./catalog";
import { tmdb, type MediaType } from "./tmdb";

const storeName = "imdb-ids";
const maxStored = 20000;
const saveDelayMs = 5000;
const batchDelayMs = 40;
const lookupsAtOnce = 6;
const nearScreen = "400px";

let ids: Map<string, string> | null = null;
let loading: Promise<Map<string, string>> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const idRequests = new Map<string, Promise<string>>();
const ratings = new Map<string, ImdbRating | null>();
const waiting = new Map<string, ((rating: ImdbRating | null) => void)[]>();
let batchTimer: ReturnType<typeof setTimeout> | undefined;
let running = 0;
const queue: (() => void)[] = [];

function storedIds(): Promise<Map<string, string>> {
  loading ??= backend
    .storeGet(storeName)
    .then((document) => {
      const parsed: unknown = document ? JSON.parse(document.text) : {};
      return new Map(typeof parsed === "object" && parsed !== null ? Object.entries(parsed as Record<string, string>) : []);
    })
    .catch(() => new Map<string, string>())
    .then((map) => {
      ids = map;
      return map;
    });
  return loading;
}

function remember(key: string, imdbId: string): void {
  if (!ids || !imdbId) return;
  ids.set(key, imdbId);
  while (ids.size > maxStored) ids.delete(ids.keys().next().value as string);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (ids) void backend.storeSet(storeName, JSON.stringify(Object.fromEntries(ids)), true).catch(() => undefined);
  }, saveDelayMs);
}

function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      running += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          queue.shift()?.();
        });
    };
    if (running < lookupsAtOnce) run();
    else queue.push(run);
  });
}

async function imdbIdOf(type: MediaType, id: number): Promise<string> {
  const key = `${type}:${id}`;
  const stored = (await storedIds()).get(key);
  if (stored) return stored;
  const known = idRequests.get(key);
  if (known) return known;
  const local = await catalogRecord(type, id).catch(() => null);
  if (local?.imdb && /^tt\d+$/.test(local.imdb)) {
    remember(key, local.imdb);
    return local.imdb;
  }
  const request = limited(() => tmdb.imdbId(type, id))
    .then((imdbId) => {
      remember(key, imdbId);
      return imdbId;
    })
    .catch(() => "")
    .finally(() => idRequests.delete(key));
  idRequests.set(key, request);
  return request;
}

function flush(): void {
  const asked = [...waiting.keys()];
  const listeners = new Map(waiting);
  waiting.clear();
  void backend
    .imdbRatings(asked)
    .catch(() => ({}) as Record<string, ImdbRating>)
    .then((found) => {
      for (const imdbId of asked) {
        const rating = found[imdbId] ?? null;
        ratings.set(imdbId, rating);
        for (const listener of listeners.get(imdbId) ?? []) listener(rating);
      }
    });
}

function ratingOf(imdbId: string): Promise<ImdbRating | null> {
  if (ratings.has(imdbId)) return Promise.resolve(ratings.get(imdbId) ?? null);
  return new Promise((resolve) => {
    const listeners = waiting.get(imdbId) ?? [];
    listeners.push(resolve);
    waiting.set(imdbId, listeners);
    clearTimeout(batchTimer);
    batchTimer = setTimeout(flush, batchDelayMs);
  });
}

const freshRatings = new Map<string, number>();

export function noteTitleRating(type: MediaType, id: number, rating: number, imdbId: string | null): void {
  const key = `${type}:${id}`;
  if (rating > 0) freshRatings.set(key, rating);
  if (imdbId && /^tt\d+$/.test(imdbId)) void storedIds().then(() => remember(key, imdbId));
}

export async function fallbackRating(type: MediaType, id: number, listRating: number): Promise<number | null> {
  const record = await catalogRecord(type, id).catch(() => null);
  if (record && record.c > 0 && record.v > 0) return record.v;
  const fresh = freshRatings.get(`${type}:${id}`);
  if (fresh !== undefined) return fresh;
  return listRating > 0 ? listRating : null;
}

export async function imdbRatingOf(type: MediaType, id: number): Promise<ImdbRating | null> {
  if (!isDesktop) return null;
  const imdbId = await imdbIdOf(type, id);
  return imdbId ? ratingOf(imdbId) : null;
}

export function useImdbRating(type: MediaType, id: number, listRating: number): { ref: React.RefObject<HTMLSpanElement | null>; rating: number | null | undefined } {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [rating, setRating] = useState<number | null | undefined>(undefined);

  useEffect(() => {
    const element = ref.current;
    let cancelled = false;
    setRating(undefined);
    const start = () =>
      void imdbRatingOf(type, id)
        .catch(() => null)
        .then((imdb) => (imdb ? imdb.rating : fallbackRating(type, id, listRating)))
        .catch(() => null)
        .then((value) => {
          if (!cancelled) setRating(value);
        });
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        start();
      },
      { rootMargin: nearScreen },
    );
    if (element) observer.observe(element);
    else start();
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [type, id, listRating]);

  return { ref, rating };
}
