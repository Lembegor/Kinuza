import { useEffect, useState } from "react";
import { backend } from "./backend";
import { catalogLanguage, type MediaItem, type MediaType } from "./tmdb";

type Language = "ru" | "uk" | "en";

export interface CatalogRecord {
  k: "m" | "t";
  id: number;
  o: string;
  l: string;
  y: number;
  v: number;
  c: number;
  p: number;
  g: number[];
  t?: Partial<Record<Language, string>>;
  i?: Record<string, string>;
  b?: string;
  n?: string[];
  a?: number;
  imdb?: string;
  mal?: number;
  s?: string;
}

export interface CatalogMatch {
  item: MediaItem;
  exact: boolean;
}

const animationGenreId = 16;
const memoryLimit = 5000;
const extrasLimit = 12;
const memory = new Map<string, CatalogRecord | null>();
const waiting = new Map<string, ((record: CatalogRecord | null) => void)[]>();
let scheduled = false;

function keyOf(type: MediaType, id: number): string {
  return `${type}:${id}`;
}

function language(): Language {
  const code = catalogLanguage().slice(0, 2);
  return code === "ru" || code === "uk" ? code : "en";
}

function comparable(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function parse(raw: string): CatalogRecord | null {
  try {
    const record = JSON.parse(raw) as CatalogRecord;
    return record && (record.k === "m" || record.k === "t") && typeof record.id === "number" ? record : null;
  } catch {
    return null;
  }
}

function typeOf(record: CatalogRecord): MediaType {
  return record.k === "m" ? "movie" : "tv";
}

function remember(key: string, record: CatalogRecord | null): void {
  memory.set(key, record);
  while (memory.size > memoryLimit) memory.delete(memory.keys().next().value as string);
}

async function flush(): Promise<void> {
  scheduled = false;
  const keys = [...waiting.keys()];
  const callbacks = new Map(waiting);
  waiting.clear();
  let found = new Map<string, CatalogRecord>();
  try {
    const rows = await backend.catalogLookup(
      keys.map((key) => {
        const [type, id] = key.split(":");
        return { kind: type, id: Number(id) };
      }),
    );
    found = new Map(
      (rows ?? [])
        .map(parse)
        .filter((record): record is CatalogRecord => record !== null)
        .map((record) => [keyOf(typeOf(record), record.id), record]),
    );
    for (const key of keys) remember(key, found.get(key) ?? null);
  } catch {
    found = new Map();
  }
  for (const [key, list] of callbacks) for (const resolve of list) resolve(found.get(key) ?? null);
}

export function catalogRecord(type: MediaType, id: number): Promise<CatalogRecord | null> {
  const key = keyOf(type, id);
  if (memory.has(key)) return Promise.resolve(memory.get(key) ?? null);
  return new Promise((resolve) => {
    const list = waiting.get(key);
    if (list) list.push(resolve);
    else waiting.set(key, [resolve]);
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => void flush(), 0);
    }
  });
}

export function cardTitle(record: CatalogRecord | null, fallback: string, lang: Language = language()): string {
  if (lang === "ru" && record?.s) return record.s;
  return fallback;
}

export function recordTitle(record: CatalogRecord, lang: Language = language()): string {
  if (lang === "ru" && record.s) return record.s;
  return record.t?.[lang] || record.t?.en || record.o;
}

export function recordItem(record: CatalogRecord, lang: Language = language()): MediaItem {
  return {
    id: record.id,
    type: typeOf(record),
    title: recordTitle(record, lang),
    originalTitle: record.o,
    overview: "",
    poster: record.i?.[lang] ?? record.i?.[""] ?? null,
    backdrop: record.b ?? null,
    year: record.y ? String(record.y) : "",
    rating: record.c > 0 ? record.v : 0,
    voteCount: record.c,
    popularity: record.p,
    genreIds: record.g ?? [],
    language: record.l,
    isAnime: (record.g ?? []).includes(animationGenreId) && record.l === "ja",
  };
}

function recordNames(record: CatalogRecord): string[] {
  return [record.o, ...Object.values(record.t ?? {}), record.s ?? "", ...(record.n ?? [])].filter(Boolean);
}

export async function catalogSearch(query: string): Promise<CatalogMatch[]> {
  const key = comparable(query);
  if (key.length < 2) return [];
  const rows = (await backend.catalogSearch(query.trim())) ?? [];
  const lang = language();
  const matches = rows
    .map(parse)
    .filter((record): record is CatalogRecord => record !== null && !record.a)
    .map((record) => ({ record, exact: recordNames(record).some((name) => comparable(name) === key) }))
    .filter(({ record }) => Boolean(record.i?.[lang] ?? record.i?.[""]));
  for (const { record } of matches) remember(keyOf(typeOf(record), record.id), record);
  const exact = matches.filter((match) => match.exact);
  const rest = matches.filter((match) => !match.exact).slice(0, extrasLimit);
  return [...exact, ...rest].map(({ record, exact: isExact }) => ({ item: recordItem(record, lang), exact: isExact }));
}

export function useCardTitle(type: MediaType, id: number, fallback: string): string {
  const key = keyOf(type, id);
  const [record, setRecord] = useState<CatalogRecord | null>(() => memory.get(key) ?? null);
  useEffect(() => {
    let alive = true;
    const known = memory.get(key);
    if (known !== undefined) {
      setRecord(known);
      return;
    }
    void catalogRecord(type, id).then((found) => {
      if (alive) setRecord(found);
    });
    return () => {
      alive = false;
    };
  }, [key, type, id]);
  return cardTitle(record, fallback);
}
