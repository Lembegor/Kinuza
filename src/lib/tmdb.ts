import { t } from "./i18n";
import { report } from "./journal";

const apiBase = "https://api.themoviedb.org/3";
const imageBase = "https://image.tmdb.org/t/p";
const animationGenreId = 16;
const catalogLocales = {
  en: { language: "en-US", region: "US" },
  uk: { language: "uk-UA", region: "UA" },
  ru: { language: "ru-RU", region: "RU" },
} as const;
let catalog: { language: string; region: string } = catalogLocales.en;
const maxRetries = 2;
const retryDelayMs = 600;
const castLimit = 14;
const videoLimit = 5;

export type MediaType = "movie" | "tv";

export interface MediaItem {
  id: number;
  type: MediaType;
  title: string;
  originalTitle: string;
  overview: string;
  poster: string | null;
  backdrop: string | null;
  year: string;
  rating: number;
  voteCount: number;
  popularity?: number;
  genreIds: number[];
  language: string;
  isAnime: boolean;
}

export interface TitleKeyword {
  id: number;
  name: string;
}

export interface TitleTaste {
  item: MediaItem;
  people: { id: number; name: string; role: "director" | "cast" }[];
  recommendations: MediaItem[];
  similar: MediaItem[];
  keywords: TitleKeyword[];
  collectionId: number | null;
}

export interface PersonRef {
  id: number;
  name: string;
  photo: string | null;
}

export interface FoundPerson extends PersonRef {
  department: string;
  knownFor: string[];
  popularity: number;
}

export interface SearchPage {
  items: MediaItem[];
  people: FoundPerson[];
  totalPages: number;
}

export interface CastMember extends PersonRef {
  character: string;
}

export interface TitleVideo {
  key: string;
  name: string;
  kind: "trailer" | "teaser" | "other";
}

export interface CollectionPart extends MediaItem {
  releaseDate: string;
}

export interface Collection {
  id: number;
  name: string;
  parts: CollectionPart[];
}

export interface Person {
  id: number;
  name: string;
  photo: string | null;
  department: string;
  biography: string;
  birthday: string;
  deathday: string;
  birthplace: string;
  directed: MediaItem[];
  acted: MediaItem[];
}

export type DiscoverKind = "movie" | "tv" | "anime";
export type DiscoverSort = "popular" | "rating" | "newest";

export interface DiscoverFilters {
  kind: DiscoverKind;
  genres: number[];
  keywords: number[];
  yearFrom: number | null;
  yearTo: number | null;
  country: string;
  minRating: number;
  sort: DiscoverSort;
}

export interface DiscoverPage {
  items: MediaItem[];
  totalPages: number;
}

export interface Genre {
  id: number;
  name: string;
}

export const animeThemes = [
  { id: 9840, key: "romance" },
  { id: 9914, key: "sliceOfLife" },
  { id: 190116, key: "school" },
  { id: 6152, key: "supernatural" },
  { id: 237451, key: "isekai" },
  { id: 293198, key: "fantasy" },
  { id: 177895, key: "darkFantasy" },
  { id: 10046, key: "mecha" },
  { id: 6075, key: "sports" },
  { id: 283297, key: "music" },
  { id: 292887, key: "magicalGirl" },
  { id: 315058, key: "horror" },
  { id: 272553, key: "psychological" },
  { id: 288394, key: "thriller" },
  { id: 291483, key: "iyashikei" },
  { id: 4379, key: "timeTravel" },
  { id: 207826, key: "shounen" },
  { id: 206437, key: "shoujo" },
  { id: 195668, key: "seinen" },
  { id: 229074, key: "josei" },
  { id: 195669, key: "ecchi" },
  { id: 9194, key: "harem" },
  { id: 280003, key: "yuri" },
  { id: 289844, key: "boysLove" },
  { id: 198385, key: "hentai", adult: true },
  { id: 256466, key: "erotica", adult: true },
] as const;

export const adultThemeIds: ReadonlySet<number> = new Set(animeThemes.filter((theme) => "adult" in theme && theme.adult).map((theme) => theme.id));

export type AnimeThemeKey = (typeof animeThemes)[number]["key"];

const adultVoteFloor = 3;
const genresHiddenForAnime: ReadonlySet<number> = new Set([animationGenreId, 99, 37, 10763, 10764, 10766, 10767]);

export interface Country {
  code: string;
  name: string;
}

export interface SeasonInfo {
  seasonNumber: number;
  name: string;
  poster: string | null;
  episodeCount: number;
  year: string;
  airDate?: string;
}

export interface ShowNames {
  name: string;
  seasons: Record<number, string>;
}

export interface Details extends MediaItem {
  tagline: string;
  genres: string[];
  runtimeMinutes: number | null;
  countries: string[];
  cast: CastMember[];
  directors: PersonRef[];
  seasons: SeasonInfo[];
  recommendations: MediaItem[];
  videos: TitleVideo[];
  trailerKey: string | null;
  collection: { id: number; name: string } | null;
  imdbId: string | null;
}

export interface Episode {
  season: number;
  episode: number;
  name: string;
  overview: string;
  still: string | null;
  airDate: string;
  runtimeMinutes: number | null;
}

export interface SeriesAiring {
  last: AiringEpisode | null;
  next: AiringEpisode | null;
  seasonPosters: Record<number, string | null>;
}

export type AiringEpisode = Pick<Episode, "season" | "episode" | "name" | "airDate">;

export type PosterSize = "w185" | "w342" | "w500";
export type BackdropSize = "w780" | "w1280" | "original";
export type StillSize = "w300" | "w500";

export function imageUrl(path: string | null, size: PosterSize | BackdropSize | StillSize): string | null {
  return path ? `${imageBase}/${size}${path}` : null;
}

let apiKeyOverride: string | null = null;

export function setApiKeyOverride(key: string | null): void {
  apiKeyOverride = key?.trim() || null;
  cache.clear();
}

export function setCatalogLanguage(code: keyof typeof catalogLocales): void {
  if (catalog === catalogLocales[code]) return;
  catalog = catalogLocales[code];
  cache.clear();
  regionNames = new Intl.DisplayNames([code], { type: "region" });
}

export function catalogLanguage(): string {
  return catalog.language;
}

export function hasApiKey(): boolean {
  return Boolean(apiKeyOverride ?? import.meta.env.VITE_TMDB_API_KEY);
}

export type CatalogHealth = "ok" | "noKey" | "keyRejected" | "unreachable";
const keyRejectedStatus = 401;

export async function catalogHealth(): Promise<CatalogHealth> {
  if (!hasApiKey()) return "noKey";
  try {
    const key = apiKeyOverride ?? import.meta.env.VITE_TMDB_API_KEY ?? "";
    const response = await fetch(`${apiBase}/configuration?api_key=${encodeURIComponent(key)}`);
    if (response.ok) return "ok";
    return response.status === keyRejectedStatus ? "keyRejected" : "unreachable";
  } catch {
    return "unreachable";
  }
}

const cache = new Map<string, Promise<unknown>>();
const cachedAt = new Map<string, number>();
const airingMaxAgeMs = 3 * 60 * 60 * 1000;
const seasonMaxAgeMs = 24 * 60 * 60 * 1000;
const defaultMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const cacheLimit = 600;
const galleryLimit = 24;

function remember(url: string, pending: Promise<unknown>): void {
  cache.delete(url);
  cache.set(url, pending);
  cachedAt.set(url, Date.now());
  while (cache.size > cacheLimit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
    cachedAt.delete(oldest);
  }
}

type Raw = Record<string, any>;

const genericEpisodeName = /^(episode|ep\.?|эпизод|епізод|серия|серія)\s*\d+$/i;
const cyrillicLetters = /[Ѐ-ӿ]/;

export function preferredPoster(fallback: string | null, posters: unknown, language: string): string | null {
  const list: Raw[] = Array.isArray(posters) ? posters.filter((poster: Raw) => typeof poster?.file_path === "string") : [];
  const byVotes = (a: Raw, b: Raw) => (b.vote_average ?? 0) - (a.vote_average ?? 0) || (b.vote_count ?? 0) - (a.vote_count ?? 0);
  const local = list.filter((poster) => poster.iso_639_1 === language).sort(byVotes);
  if (local.some((poster) => poster.file_path === fallback)) return fallback;
  if (local.length > 0) return local[0].file_path;
  const textless = list.filter((poster) => poster.iso_639_1 === null).sort(byVotes);
  return textless[0]?.file_path ?? fallback;
}

function episodeName(raw: Raw): string {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const fallback = t("common.episodeNumber", { episode: raw.episode_number });
  if (!name || genericEpisodeName.test(name)) return fallback;
  const language = catalog.language.slice(0, 2);
  if ((language === "ru" || language === "uk") && !cyrillicLetters.test(name)) return fallback;
  return name;
}

async function fetchWithRetry(url: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= maxRetries) throw new Error(`tmdb_${response.status}`);
    } catch (error) {
      const networkFailure = error instanceof TypeError;
      if (!networkFailure || attempt >= maxRetries) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
  }
}

function request<T>(path: string, params: Record<string, string | number> = {}, maxAgeMs = defaultMaxAgeMs): Promise<T> {
  const query = new URLSearchParams({
    api_key: apiKeyOverride ?? import.meta.env.VITE_TMDB_API_KEY ?? "",
    language: catalog.language,
    include_adult: "false",
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
  });
  const url = `${apiBase}${path}?${query}`;

  const cached = cache.get(url);
  if (cached && Date.now() - (cachedAt.get(url) ?? 0) <= maxAgeMs) {
    cache.delete(url);
    cache.set(url, cached);
    return cached as Promise<T>;
  }

  const pending = fetchWithRetry(url);
  pending.catch(() => cache.delete(url));
  pending.catch((error) => {
    if (!(error instanceof Error && error.message === "tmdb_404")) report("catalog", "journal.catalog.failed", error);
  });
  remember(url, pending);
  return pending as Promise<T>;
}

let regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryName(isoCode: string | undefined, fallback: string): string {
  try {
    return (isoCode && regionNames.of(isoCode)) || fallback;
  } catch {
    return fallback;
  }
}

function toItem(raw: Raw, fallbackType?: MediaType): MediaItem | null {
  const type = (raw.media_type as string | undefined) ?? fallbackType;
  if (type !== "movie" && type !== "tv") return null;
  const date: string = (type === "movie" ? raw.release_date : raw.first_air_date) ?? "";
  const genreIds: number[] = raw.genre_ids ?? (raw.genres ?? []).map((genre: Raw) => genre.id);
  return {
    id: raw.id,
    type,
    title: (type === "movie" ? raw.title : raw.name) ?? "",
    originalTitle: (type === "movie" ? raw.original_title : raw.original_name) ?? "",
    overview: raw.overview ?? "",
    poster: raw.poster_path ?? null,
    backdrop: raw.backdrop_path ?? null,
    year: date.slice(0, 4),
    rating: raw.vote_count > 0 ? raw.vote_average : 0,
    voteCount: raw.vote_count ?? 0,
    popularity: raw.popularity ?? 0,
    genreIds,
    language: raw.original_language ?? "",
    isAnime: genreIds.includes(animationGenreId) && raw.original_language === "ja",
  };
}

function toItems(results: Raw[] | undefined, fallbackType?: MediaType): MediaItem[] {
  return (results ?? [])
    .map((raw) => toItem(raw, fallbackType))
    .filter((item): item is MediaItem => item !== null && Boolean(item.poster));
}

function toPlainItems(results: Raw[] | undefined, type: MediaType): MediaItem[] {
  return (results ?? []).map((raw) => toItem(raw, type)).filter((item): item is MediaItem => item !== null);
}

async function list(path: string, type?: MediaType, params: Record<string, string | number> = {}): Promise<MediaItem[]> {
  const data = await request<Raw>(path, params);
  return toItems(data.results, type);
}

function toPersonRef(raw: Raw): PersonRef {
  return { id: raw.id, name: raw.name ?? "", photo: raw.profile_path ?? null };
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string | number): T[] {
  const seen = new Set<string | number>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function directorsOf(raw: Raw, type: MediaType): Raw[] {
  return type === "movie" ? (raw.credits?.crew ?? []).filter((person: Raw) => person.job === "Director") : (raw.created_by ?? []);
}

const videoKinds: Record<string, TitleVideo["kind"]> = { Trailer: "trailer", Teaser: "teaser" };

function toVideos(results: Raw[] | undefined): TitleVideo[] {
  const language = catalog.language.slice(0, 2);
  const rank = (video: Raw) =>
    (video.iso_639_1 === language ? 0 : 4) + (video.type === "Trailer" ? 0 : 2) + (video.official ? 0 : 1);
  const sorted = (results ?? []).filter((video) => video.site === "YouTube" && video.key).sort((a, b) => rank(a) - rank(b));
  const trailers = sorted.filter((video) => video.type in videoKinds);
  return (trailers.length > 0 ? trailers : sorted.slice(0, 1)).slice(0, videoLimit).map((video) => ({
    key: video.key,
    name: video.name ?? "",
    kind: videoKinds[video.type] ?? "other",
  }));
}

const leadingCastCount = 5;

const discoverVoteFloor: Record<DiscoverSort, Record<MediaType, number>> = {
  popular: { movie: 30, tv: 15 },
  rating: { movie: 300, tv: 200 },
  newest: { movie: 20, tv: 10 },
};
const ratedVoteFloor: Record<MediaType, number> = { movie: 100, tv: 50 };
const discoverSortField: Record<DiscoverSort, Record<MediaType, string>> = {
  popular: { movie: "popularity.desc", tv: "popularity.desc" },
  rating: { movie: "vote_average.desc", tv: "vote_average.desc" },
  newest: { movie: "primary_release_date.desc", tv: "first_air_date.desc" },
};
const discoverDateField: Record<MediaType, string> = { movie: "primary_release_date", tv: "first_air_date" };
const isoDateLength = "2000-01-01".length;
const discoverPageLimit = 500;

function discoverType(kind: DiscoverKind): MediaType {
  return kind === "movie" ? "movie" : "tv";
}

function discoverParams(filters: DiscoverFilters, page: number): Record<string, string | number> {
  const type = discoverType(filters.kind);
  const dateField = discoverDateField[type];
  const genres = filters.kind === "anime" ? [animationGenreId, ...filters.genres] : filters.genres;
  const params: Record<string, string | number> = {
    page,
    sort_by: discoverSortField[filters.sort][type],
    "vote_count.gte": Math.max(discoverVoteFloor[filters.sort][type], filters.minRating > 0 ? ratedVoteFloor[type] : 0),
  };
  if (genres.length > 0) params.with_genres = genres.join(",");
  if (filters.kind === "anime" && filters.keywords.length > 0) params.with_keywords = filters.keywords.join(",");
  if (filters.kind === "anime" && filters.keywords.some((id) => adultThemeIds.has(id))) {
    params.include_adult = "true";
    params["vote_count.gte"] = Math.min(Number(params["vote_count.gte"]), adultVoteFloor);
  }
  if (filters.kind === "anime") params.with_original_language = "ja";
  if (filters.country) params.with_origin_country = filters.country;
  if (filters.minRating > 0) params["vote_average.gte"] = filters.minRating;
  if (filters.yearFrom) params[`${dateField}.gte`] = `${filters.yearFrom}-01-01`;

  const lastDay = filters.yearTo ? `${filters.yearTo}-12-31` : "";
  const today = new Date().toISOString().slice(0, isoDateLength);
  const until = filters.sort === "newest" && (!lastDay || today < lastDay) ? today : lastDay;
  if (until) params[`${dateField}.lte`] = until;
  return params;
}

const guestAppearanceGenreIds = [10767, 10763];
const selfAppearancePattern = /^(self|himself|herself|themselves)\b/i;
const directingJobs = ["Director", "Creator"];

function toFilmography(credits: Raw[]): MediaItem[] {
  return uniqueBy(toItems(credits), (item) => `${item.type}:${item.id}`).sort((a, b) => b.voteCount - a.voteCount);
}

export const tmdb = {
  trending: () => list("/trending/all/week"),
  popularMovies: () => list("/movie/popular", "movie"),
  topMovies: () => list("/movie/top_rated", "movie"),
  nowPlaying: () => list("/movie/now_playing", "movie", { region: catalog.region }),
  popularSeries: () => list("/trending/tv/week", "tv"),
  topSeries: () => list("/tv/top_rated", "tv"),
  anime: () =>
    list("/discover/tv", "tv", {
      with_genres: animationGenreId,
      with_original_language: "ja",
      sort_by: "popularity.desc",
      "vote_count.gte": 50,
    }),
  animeMovies: () =>
    list("/discover/movie", "movie", {
      with_genres: animationGenreId,
      with_original_language: "ja",
      sort_by: "popularity.desc",
      "vote_count.gte": 200,
    }),

  search: (query: string) => list("/search/multi", undefined, { query, page: 1 }),

  async searchEverything(query: string, page: number): Promise<SearchPage> {
    const data = await request<Raw>("/search/multi", { query, page });
    const results: Raw[] = data.results ?? [];
    const people = results
      .filter((raw) => raw.media_type === "person")
      .map((raw) => ({
        ...toPersonRef(raw),
        department: raw.known_for_department ?? "",
        knownFor: ((raw.known_for ?? []) as Raw[])
          .map((work) => (work.media_type === "tv" ? work.name : work.title) ?? "")
          .filter(Boolean)
          .slice(0, 2),
        popularity: raw.popularity ?? 0,
      }));
    return { items: toItems(results), people, totalPages: data.total_pages ?? 1 };
  },

  async searchByName(type: MediaType, query: string, options: { year?: number | null; language?: string } = {}): Promise<MediaItem[]> {
    const params: Record<string, string | number> = { query, page: 1 };
    if (options.year) params[type === "movie" ? "year" : "first_air_date_year"] = options.year;
    if (options.language) params.language = options.language;
    const data = await request<Raw>(`/search/${type}`, params);
    return toPlainItems(data.results, type);
  },

  async findByImdbId(imdbId: string): Promise<MediaItem[]> {
    const data = await request<Raw>(`/find/${imdbId}`, { external_source: "imdb_id" });
    return [...toPlainItems(data.movie_results, "movie"), ...toPlainItems(data.tv_results, "tv")];
  },

  async summary(type: MediaType, id: number): Promise<MediaItem> {
    const item = toItem(await request<Raw>(`/${type}/${id}`), type);
    if (!item) throw new Error("tmdb_bad_item");
    return item;
  },

  async details(type: MediaType, id: number): Promise<Details> {
    const language = catalog.language.slice(0, 2);
    const raw = await request<Raw>(`/${type}/${id}`, {
      append_to_response: "credits,recommendations,videos,external_ids,images",
      include_video_language: [...new Set([language, "en"])].join(","),
      include_image_language: `${language},null`,
    });
    const item = toItem(raw, type);
    if (!item) throw new Error("tmdb_bad_item");
    const base = { ...item, poster: preferredPoster(item.poster, raw.images?.posters, language) };

    const videos = toVideos(raw.videos?.results);

    const runtime: number | null =
      type === "movie" ? raw.runtime || null : (raw.episode_run_time?.[0] ?? null);

    return {
      ...base,
      tagline: raw.tagline ?? "",
      genres: (raw.genres ?? []).map((genre: Raw) => genre.name),
      runtimeMinutes: runtime,
      countries: (raw.production_countries ?? []).map((country: Raw) => countryName(country.iso_3166_1, country.name)),
      cast: (raw.credits?.cast ?? []).slice(0, castLimit).map((person: Raw) => ({
        ...toPersonRef(person),
        character: person.character ?? "",
      })),
      directors: uniqueBy(directorsOf(raw, type).map(toPersonRef), (person) => person.id),
      seasons: (raw.seasons ?? [])
        .filter((season: Raw) => season.episode_count > 0)
        .map((season: Raw) => ({
          seasonNumber: season.season_number,
          name: season.name,
          poster: season.poster_path ?? null,
          episodeCount: season.episode_count,
          year: (season.air_date ?? "").slice(0, 4),
          airDate: season.air_date ?? "",
        }))
        .sort((a: SeasonInfo, b: SeasonInfo) => (a.seasonNumber || Infinity) - (b.seasonNumber || Infinity)),
      recommendations: toItems(raw.recommendations?.results, type).slice(0, 18),
      videos,
      trailerKey: videos[0]?.key ?? null,
      collection: raw.belongs_to_collection ? { id: raw.belongs_to_collection.id, name: raw.belongs_to_collection.name ?? "" } : null,
      imdbId: raw.external_ids?.imdb_id || raw.imdb_id || null,
    };
  },

  async taste(type: MediaType, id: number): Promise<TitleTaste> {
    const raw = await request<Raw>(`/${type}/${id}`, { append_to_response: "credits,recommendations,similar,keywords" });
    const item = toItem(raw, type);
    if (!item) throw new Error("tmdb_bad_item");

    const directors = directorsOf(raw, type);
    const cast: Raw[] = (raw.credits?.cast ?? []).slice(0, leadingCastCount);
    return {
      item,
      people: [
        ...directors.map((person) => ({ id: person.id as number, name: person.name as string, role: "director" as const })),
        ...cast.map((person) => ({ id: person.id as number, name: person.name as string, role: "cast" as const })),
      ],
      recommendations: toItems(raw.recommendations?.results, type),
      similar: toItems(raw.similar?.results, type),
      keywords: ((raw.keywords?.keywords ?? raw.keywords?.results ?? []) as Raw[]).map((keyword) => ({
        id: keyword.id as number,
        name: (keyword.name as string) ?? "",
      })),
      collectionId: raw.belongs_to_collection?.id ?? null,
    };
  },

  byKeywords: (type: MediaType, keywordIds: number[]) =>
    list(`/discover/${type}`, type, { with_keywords: keywordIds.join("|"), sort_by: "vote_count.desc", "vote_count.gte": 150 }),

  recentByGenres(type: MediaType, genreIds: number[], sinceDays: number): Promise<MediaItem[]> {
    const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, isoDateLength);
    const today = new Date().toISOString().slice(0, isoDateLength);
    return list(`/discover/${type}`, type, {
      with_genres: genreIds.join("|"),
      sort_by: "popularity.desc",
      "vote_count.gte": 40,
      [`${discoverDateField[type]}.gte`]: since,
      [`${discoverDateField[type]}.lte`]: today,
    });
  },

  bestOfGenre: (type: MediaType, genreId: number) =>
    list(`/discover/${type}`, type, { with_genres: genreId, sort_by: "vote_count.desc", "vote_average.gte": 7, "vote_count.gte": 400 }),

  async personFilms(personId: number, role: "director" | "cast"): Promise<MediaItem[]> {
    const raw = await request<Raw>(`/person/${personId}/movie_credits`);
    const credits: Raw[] = role === "director" ? (raw.crew ?? []).filter((credit: Raw) => credit.job === "Director") : (raw.cast ?? []);
    return toItems(credits, "movie");
  },

  async discover(filters: DiscoverFilters, page: number): Promise<DiscoverPage> {
    const type = discoverType(filters.kind);
    const data = await request<Raw>(`/discover/${type}`, discoverParams(filters, page));
    return { items: toItems(data.results, type), totalPages: Math.min(data.total_pages ?? 1, discoverPageLimit) };
  },

  async genres(kind: DiscoverKind): Promise<Genre[]> {
    const raw = await request<Raw>(`/genre/${discoverType(kind)}/list`);
    const genres: Genre[] = (raw.genres ?? []).map((genre: Raw) => ({ id: genre.id, name: genre.name }));
    return kind === "anime" ? genres.filter((genre) => !genresHiddenForAnime.has(genre.id)) : genres;
  },

  async countries(): Promise<Country[]> {
    const raw = await request<Raw[]>("/configuration/countries");
    const collator = new Intl.Collator(catalog.language);
    return raw
      .map((country) => ({ code: country.iso_3166_1 as string, name: countryName(country.iso_3166_1, country.english_name) }))
      .sort((a, b) => collator.compare(a.name, b.name));
  },

  async images(type: MediaType, id: number): Promise<string[]> {
    const language = catalog.language.slice(0, 2);
    const raw = await request<Raw>(`/${type}/${id}/images`, { include_image_language: [...new Set(["null", language, "en"])].join(",") });
    const backdrops: Raw[] = Array.isArray(raw.backdrops) ? raw.backdrops : [];
    return backdrops
      .filter((image) => typeof image.file_path === "string" && (image.width ?? 0) >= 1280)
      .sort((a, b) => Number(a.iso_639_1 !== null) - Number(b.iso_639_1 !== null) || (b.vote_average ?? 0) - (a.vote_average ?? 0))
      .slice(0, galleryLimit)
      .map((image) => image.file_path as string);
  },

  async collection(id: number): Promise<Collection> {
    const raw = await request<Raw>(`/collection/${id}`);
    const parts: CollectionPart[] = (raw.parts ?? []).flatMap((part: Raw) => {
      const item = toItem(part, "movie");
      return item ? [{ ...item, releaseDate: part.release_date ?? "" }] : [];
    });
    const byRelease = (a: CollectionPart, b: CollectionPart) =>
      Number(!a.releaseDate) - Number(!b.releaseDate) || a.releaseDate.localeCompare(b.releaseDate);
    return { id: raw.id, name: raw.name ?? "", parts: parts.sort(byRelease) };
  },

  async person(id: number): Promise<Person> {
    const raw = await request<Raw>(`/person/${id}`, { append_to_response: "combined_credits" });
    const needsEnglish = !raw.biography && catalog !== catalogLocales.en;
    const english = needsEnglish ? await request<Raw>(`/person/${id}`, { language: catalogLocales.en.language }) : null;
    const crew: Raw[] = raw.combined_credits?.crew ?? [];
    const cast: Raw[] = raw.combined_credits?.cast ?? [];
    const isGuestAppearance = (credit: Raw) =>
      selfAppearancePattern.test(credit.character ?? "") ||
      (credit.genre_ids ?? []).some((genreId: number) => guestAppearanceGenreIds.includes(genreId));
    return {
      id: raw.id,
      name: raw.name ?? "",
      photo: raw.profile_path ?? null,
      department: raw.known_for_department ?? "",
      biography: raw.biography || english?.biography || "",
      birthday: raw.birthday ?? "",
      deathday: raw.deathday ?? "",
      birthplace: raw.place_of_birth ?? "",
      directed: toFilmography(crew.filter((credit) => directingJobs.includes(credit.job))),
      acted: toFilmography(cast.filter((credit) => !isGuestAppearance(credit))),
    };
  },

  async genreNames(): Promise<Map<number, string>> {
    const [movie, tv] = await Promise.all([request<Raw>("/genre/movie/list"), request<Raw>("/genre/tv/list")]);
    return new Map([...(tv.genres ?? []), ...(movie.genres ?? [])].map((genre: Raw) => [genre.id as number, genre.name as string]));
  },

  mostVoted(kind: DiscoverKind, page: number): Promise<MediaItem[]> {
    const type = discoverType(kind);
    const params: Record<string, string | number> = { page, sort_by: "vote_count.desc" };
    if (kind === "anime") {
      params.with_genres = animationGenreId;
      params.with_original_language = "ja";
    }
    return list(`/discover/${type}`, type, params);
  },

  async airing(seriesId: number): Promise<SeriesAiring> {
    const raw = await request<Raw>(`/tv/${seriesId}`, {}, airingMaxAgeMs);
    const toEpisode = (episode: Raw | null | undefined): AiringEpisode | null =>
      episode
        ? {
            season: episode.season_number,
            episode: episode.episode_number,
            name: episodeName(episode),
            airDate: episode.air_date ?? "",
          }
        : null;
    const seasonPosters: Record<number, string | null> = Object.fromEntries(
      ((raw.seasons ?? []) as Raw[]).map((season) => [season.season_number as number, (season.poster_path as string | null) ?? null]),
    );
    return { last: toEpisode(raw.last_episode_to_air), next: toEpisode(raw.next_episode_to_air), seasonPosters };
  },

  async movieTitle(movieId: number, language: string): Promise<string> {
    const raw = await request<Raw>(`/movie/${movieId}`, { language }, seasonMaxAgeMs);
    return raw.title ?? "";
  },

  async showNames(seriesId: number, language: string): Promise<ShowNames> {
    const raw = await request<Raw>(`/tv/${seriesId}`, { language }, seasonMaxAgeMs);
    return {
      name: raw.name ?? "",
      seasons: Object.fromEntries((raw.seasons ?? []).map((season: Raw) => [season.season_number, season.name ?? ""])),
    };
  },
  async season(seriesId: number, seasonNumber: number): Promise<Episode[]> {
    const raw = await request<Raw>(`/tv/${seriesId}/season/${seasonNumber}`, {}, seasonMaxAgeMs);
    return (raw.episodes ?? []).map((episode: Raw) => ({
      season: seasonNumber,
      episode: episode.episode_number,
      name: episodeName(episode),
      overview: episode.overview ?? "",
      still: episode.still_path ?? null,
      airDate: episode.air_date ?? "",
      runtimeMinutes: episode.runtime ?? null,
    }));
  },
};

