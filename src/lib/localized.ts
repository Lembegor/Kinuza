import { animeInfo, animeText, type AnimeText } from "./anilist";
import { backend, isDesktop, type ShikimoriAnime, type TitleLinks } from "./backend";
import { t, type MessageKey } from "./i18n";
import type { AppLanguage } from "./languages";
import { catalogLanguage, tmdb, type Details, type MediaItem } from "./tmdb";

export interface LocalizedTexts {
  title: string;
  overview: string;
  genres: string[] | null;
}

const animeGenreKeys: Record<string, MessageKey> = {
  "Action": "anime.genre.action",
  "Adventure": "anime.genre.adventure",
  "Cars": "anime.genre.cars",
  "Comedy": "anime.genre.comedy",
  "Dementia": "anime.genre.dementia",
  "Demons": "anime.genre.demons",
  "Drama": "anime.genre.drama",
  "Ecchi": "anime.genre.ecchi",
  "Erotica": "anime.genre.erotica",
  "Fantasy": "anime.genre.fantasy",
  "Game": "anime.genre.game",
  "Gourmet": "anime.genre.gourmet",
  "Harem": "anime.genre.harem",
  "Hentai": "anime.genre.hentai",
  "Historical": "anime.genre.historical",
  "Horror": "anime.genre.horror",
  "Josei": "anime.genre.josei",
  "Kids": "anime.genre.kids",
  "Magic": "anime.genre.magic",
  "Martial Arts": "anime.genre.martialArts",
  "Mecha": "anime.genre.mecha",
  "Military": "anime.genre.military",
  "Music": "anime.genre.music",
  "Mystery": "anime.genre.mystery",
  "Parody": "anime.genre.parody",
  "Police": "anime.genre.police",
  "Psychological": "anime.genre.psychological",
  "Romance": "anime.genre.romance",
  "Samurai": "anime.genre.samurai",
  "School": "anime.genre.school",
  "Sci-Fi": "anime.genre.sciFi",
  "Seinen": "anime.genre.seinen",
  "Shoujo": "anime.genre.shoujo",
  "Shoujo Ai": "anime.genre.shoujoAi",
  "Shounen": "anime.genre.shounen",
  "Shounen Ai": "anime.genre.shounenAi",
  "Slice of Life": "anime.genre.sliceOfLife",
  "Space": "anime.genre.space",
  "Sports": "anime.genre.sports",
  "Super Power": "anime.genre.superPower",
  "Supernatural": "anime.genre.supernatural",
  "Thriller": "anime.genre.thriller",
  "Vampire": "anime.genre.vampire",
  "Work Life": "anime.genre.workLife",
  "Yaoi": "anime.genre.yaoi",
  "Yuri": "anime.genre.yuri",
};
const audienceGenres: ReadonlySet<string> = new Set(["Shounen", "Shoujo", "Seinen", "Josei", "Kids"]);

export function animeGenreNames(anime: ShikimoriAnime, language: AppLanguage): string[] {
  const ordered = [...anime.genres].sort((a, b) => Number(audienceGenres.has(a.name)) - Number(audienceGenres.has(b.name)));
  const names = ordered.map((genre) => {
    const key = animeGenreKeys[genre.name];
    if (key) return t(key);
    return language === "ru" && genre.russian.trim() ? genre.russian.trim() : genre.name.trim();
  });
  return [...new Set(names.filter(Boolean))];
}

function trustedGenres(anime: ShikimoriAnime | null, trusted: boolean, language: AppLanguage): string[] | null {
  if (!anime || !trusted) return null;
  const names = animeGenreNames(anime, language);
  return names.length > 0 ? names : null;
}

interface AnimeIds {
  mal: number | null;
  anilist: number | null;
  linked: boolean;
}

const cyrillic = /[Ѐ-ӿ]/;
const memoryLimit = 300;
const searchMinChars = 3;
const searchExtrasLimit = 8;

export function hasCyrillic(text: string): boolean {
  return cyrillic.test(text);
}

function comparable(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function sameWork(tmdbNames: string[], animeNames: string[]): boolean {
  const known = new Set(tmdbNames.map(comparable).filter(Boolean));
  return animeNames.some((name) => {
    const key = comparable(name);
    return key !== "" && known.has(key);
  });
}

function remembered<T>(store: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit) return hit;
  const pending = load();
  pending.catch(() => store.delete(key));
  store.set(key, pending);
  while (store.size > memoryLimit) store.delete(store.keys().next().value as string);
  return pending;
}

const linksMemory = new Map<string, Promise<TitleLinks | null>>();
const animeMemory = new Map<string, Promise<ShikimoriAnime | null>>();
const namesMemory = new Map<string, Promise<Map<number, string>>>();
const searchMemory = new Map<string, Promise<NameMatch[]>>();

export function titleLinks(type: Details["type"], id: number): Promise<TitleLinks | null> {
  if (!isDesktop) return Promise.resolve(null);
  return remembered(linksMemory, `${type}:${id}`, () => backend.wikidataLinks(type, id));
}

export function shikimoriAnime(malId: number): Promise<ShikimoriAnime | null> {
  if (!isDesktop) return Promise.resolve(null);
  return remembered(animeMemory, String(malId), () => backend.shikimoriAnime(malId));
}

export function shikimoriNames(malIds: number[]): Promise<Map<number, string>> {
  const ids = [...new Set(malIds)].sort((a, b) => a - b);
  if (!isDesktop || ids.length === 0) return Promise.resolve(new Map());
  return remembered(namesMemory, ids.join(","), async () => {
    const rows = (await backend.shikimoriNames(ids)) ?? [];
    return new Map(rows.filter((row) => hasCyrillic(row.russian)).map((row) => [row.id, row.russian]));
  });
}

type TitleNames = Pick<Details, "type" | "id" | "title" | "originalTitle" | "year">;

async function animeIds(details: TitleNames, links: TitleLinks | null): Promise<AnimeIds> {
  if (links?.mal || links?.anilist) return { mal: links.mal, anilist: links.anilist, linked: true };
  const info = await animeInfo({ names: [details.originalTitle, details.title], type: details.type, year: Number(details.year) || null }).catch(() => null);
  return { mal: info?.current.malId ?? null, anilist: info?.current.id ?? null, linked: false };
}

async function aniListEntry(ids: AnimeIds): Promise<AnimeText | null> {
  if (ids.anilist) return animeText({ id: ids.anilist });
  if (ids.mal) return animeText({ malId: ids.mal });
  return null;
}

async function shikimoriEntry(ids: AnimeIds): Promise<ShikimoriAnime | null> {
  const mal = ids.mal ?? (ids.anilist ? ((await animeText({ id: ids.anilist }))?.malId ?? null) : null);
  return mal ? shikimoriAnime(mal).catch(() => null) : null;
}

export function needsLocalizing(details: Details, language: AppLanguage): boolean {
  if (details.isAnime) return true;
  if (language !== "ru" && language !== "uk") return false;
  return !hasCyrillic(details.title) || !details.overview.trim();
}

function tmdbNames(details: TitleNames): string[] {
  return [details.originalTitle, details.title];
}

async function russianAnime(details: Details, links: TitleLinks | null): Promise<LocalizedTexts> {
  const ids = await animeIds(details, links);
  const anime = await shikimoriEntry(ids);
  const verified = anime !== null && sameWork(tmdbNames(details), anime.names);
  const fallbackDescription = ids.linked ? (anime?.description ?? "") : "";
  const tmdbTitle = hasCyrillic(details.title) ? details.title : "";
  const title = (verified && anime.russian) || tmdbTitle || links?.ru || details.title;
  const overview = (verified && anime.description) || details.overview.trim() || fallbackDescription || details.overview;
  return { title, overview, genres: trustedGenres(anime, verified || ids.linked, "ru") };
}

async function englishAnime(details: Details, links: TitleLinks | null): Promise<LocalizedTexts> {
  const ids = await animeIds(details, links);
  const [anime, shikimori] = await Promise.all([aniListEntry(ids), shikimoriEntry(ids)]);
  const verified = anime !== null && sameWork(tmdbNames(details), [anime.native, anime.romaji, anime.english]);
  const fallbackDescription = ids.linked ? (anime?.description ?? "") : "";
  const title = (verified && anime.english) || details.title;
  const overview = (verified && anime.description) || details.overview.trim() || fallbackDescription || details.overview;
  const shikimoriVerified = shikimori !== null && sameWork(tmdbNames(details), shikimori.names);
  return { title, overview, genres: trustedGenres(shikimori, shikimoriVerified || ids.linked, "en") };
}

async function ukrainianAnime(details: Details, links: TitleLinks | null): Promise<LocalizedTexts> {
  const ids = await animeIds(details, links);
  const anime = await shikimoriEntry(ids);
  const verified = anime !== null && sameWork(tmdbNames(details), anime.names);
  return {
    title: hasCyrillic(details.title) ? details.title : links?.uk || details.title,
    overview: details.overview,
    genres: trustedGenres(anime, verified || ids.linked, "uk"),
  };
}

export async function localizedTexts(details: Details, language: AppLanguage): Promise<LocalizedTexts> {
  const original: LocalizedTexts = { title: details.title, overview: details.overview, genres: null };
  if (!needsLocalizing(details, language)) return original;
  const links = await titleLinks(details.type, details.id).catch(() => null);

  if (details.isAnime && language === "ru") return russianAnime(details, links);
  if (details.isAnime && language === "en") return englishAnime(details, links);
  if (details.isAnime && language === "uk") return ukrainianAnime(details, links);

  const label = language === "ru" ? links?.ru : links?.uk;
  return {
    title: hasCyrillic(details.title) ? details.title : label || details.title,
    overview: details.overview,
    genres: null,
  };
}

export function namesContain(query: string, names: string[]): boolean {
  const key = comparable(query);
  return key.length >= searchMinChars && names.some((name) => comparable(name).includes(key));
}

export interface NameMatch {
  item: MediaItem;
  exact: boolean;
}

export function animeByName(query: string): Promise<NameMatch[]> {
  const key = comparable(query);
  if (!isDesktop || key.length < searchMinChars) return Promise.resolve([]);
  const memoryKey = `${catalogLanguage()}:${key}`;
  return remembered(searchMemory, memoryKey, async () => {
    const found = ((await backend.shikimoriSearch(query.trim())) ?? []).filter((anime) => namesContain(query, [anime.russian, anime.name]));
    if (found.length === 0) return [];
    const links = (await backend.wikidataByMal(found.map((anime) => anime.id))) ?? [];
    const targets = new Map<string, { kind: "movie" | "tv"; tmdbId: number; exact: boolean }>();
    for (const anime of found) {
      const exact = [anime.russian, anime.name].some((name) => comparable(name) === key);
      for (const link of links.filter((candidate) => candidate.mal === anime.id)) {
        const id = `${link.kind}:${link.tmdbId}`;
        const known = targets.get(id);
        if (!known) targets.set(id, { kind: link.kind, tmdbId: link.tmdbId, exact });
        else if (exact) known.exact = true;
      }
    }
    const chosen = [...targets.values()].slice(0, searchExtrasLimit);
    const items = await Promise.all(
      chosen.map(async (target) => {
        const item = await tmdb.summary(target.kind, target.tmdbId).catch(() => null);
        return item ? { item, exact: target.exact } : null;
      }),
    );
    const kept = items.filter((match): match is NameMatch => match !== null);
    if (kept.length < items.length) setTimeout(() => searchMemory.delete(memoryKey), 0);
    return kept;
  });
}

export async function animeTrackerNames(title: TitleNames): Promise<string[]> {
  if (!isDesktop) return [];
  const links = await titleLinks(title.type, title.id).catch(() => null);
  const ids = await animeIds(title, links);
  const anime = await shikimoriEntry(ids);
  if (!anime || !(ids.linked || sameWork(tmdbNames(title), anime.names))) return [];
  return [anime.russian, ...anime.names].map((name) => name.trim()).filter(Boolean);
}
