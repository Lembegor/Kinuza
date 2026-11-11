// TMDB client: catalog, search, details and episode lists, with an in-memory cache.

import { t } from "./i18n";
import { report } from "./journal";

const apiBase = "https://api.themoviedb.org/3";
const imageBase = "https://image.tmdb.org/t/p";
const animationGenreId = 16;
/** Catalog language and the country whose cinemas "now playing" means, per interface language. */
const catalogLocales = {
  en: { language: "en-US", region: "US" },
  uk: { language: "uk-UA", region: "UA" },
  ru: { language: "ru-RU", region: "RU" },
} as const;
let catalog: { language: string; region: string } = catalogLocales.en;
const maxRetries = 2;
const retryDelayMs = 600;
const castLimit = 14;
/** Trailers offered for one title: as many as fit on one line under the player with their names readable. */
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
  /** How many people the rating comes from; a rating with few votes means little. */
  voteCount: number;
  genreIds: number[];
  /** ISO 639-1 code of the original language. */
  language: string;
  isAnime: boolean;
}

/** A title with what recommendations are built from: who made it and what the catalog finds similar. */
export interface TitleTaste {
  item: MediaItem;
  /** Directors and creators first, then the leading cast. */
  people: { id: number; name: string; role: "director" | "cast" }[];
  recommendations: MediaItem[];
  similar: MediaItem[];
}

export interface PersonRef {
  id: number;
  name: string;
  photo: string | null;
}

export interface CastMember extends PersonRef {
  character: string;
}

/** A video on YouTube: a trailer, a teaser, or whatever else the title has when it has neither. */
export interface TitleVideo {
  key: string;
  name: string;
  kind: "trailer" | "teaser" | "other";
}

/** A film of a franchise; a part that is only announced may have neither a date nor a poster. */
export interface CollectionPart extends MediaItem {
  /** ISO date, empty while the release is not scheduled. */
  releaseDate: string;
}

export interface Collection {
  id: number;
  name: string;
  /** In release order; parts without a date come last. */
  parts: CollectionPart[];
}

export interface Person {
  id: number;
  name: string;
  photo: string | null;
  /** TMDB's department name in English, such as "Acting" or "Directing"; empty when unknown. */
  department: string;
  biography: string;
  birthday: string;
  deathday: string;
  birthplace: string;
  /** Films and series, most notable first. */
  directed: MediaItem[];
  acted: MediaItem[];
}

export type DiscoverKind = "movie" | "tv" | "anime";
export type DiscoverSort = "popular" | "rating" | "newest";

export interface DiscoverFilters {
  kind: DiscoverKind;
  /** A title must have every one of these genres. */
  genres: number[];
  yearFrom: number | null;
  yearTo: number | null;
  /** ISO 3166-1 code of the country of origin; empty for any. */
  country: string;
  /** Lowest catalog rating, 0 for any. */
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

export interface Country {
  code: string;
  name: string;
}

export interface SeasonInfo {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  year: string;
}

export interface Details extends MediaItem {
  tagline: string;
  genres: string[];
  runtimeMinutes: number | null;
  countries: string[];
  cast: CastMember[];
  /** Directors of a film, creators of a series. */
  directors: PersonRef[];
  seasons: SeasonInfo[];
  recommendations: MediaItem[];
  /** Trailers and teasers, the one to play first at the head. */
  videos: TitleVideo[];
  /** Key of the first of `videos`. */
  trailerKey: string | null;
  /** The franchise a film is part of. */
  collection: { id: number; name: string } | null;
  /** IMDb identifier such as "tt1375666"; null when TMDB does not know it. */
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

/** Where a series stands on air: the episode shown last and the one coming next, when the catalog knows them. */
export interface SeriesAiring {
  last: AiringEpisode | null;
  next: AiringEpisode | null;
}

export type AiringEpisode = Pick<Episode, "season" | "episode" | "name" | "airDate">;

export type PosterSize = "w185" | "w342" | "w500";
export type BackdropSize = "w780" | "w1280" | "original";
export type StillSize = "w300" | "w500";

export function imageUrl(path: string | null, size: PosterSize | BackdropSize | StillSize): string | null {
  return path ? `${imageBase}/${size}${path}` : null;
}

let apiKeyOverride: string | null = null;

/** Lets the settings screen replace the key baked into the build. */
export function setApiKeyOverride(key: string | null): void {
  apiKeyOverride = key?.trim() || null;
  cache.clear();
}

/** Switches the language titles and descriptions come in. */
export function setCatalogLanguage(code: keyof typeof catalogLocales): void {
  if (catalog === catalogLocales[code]) return;
  catalog = catalogLocales[code];
  cache.clear();
  regionNames = new Intl.DisplayNames([code], { type: "region" });
}

/** Changes with the catalog language; lists loaded for one language must be reloaded for another. */
export function catalogLanguage(): string {
  return catalog.language;
}

export function hasApiKey(): boolean {
  return Boolean(apiKeyOverride ?? import.meta.env.VITE_TMDB_API_KEY);
}

export type CatalogHealth = "ok" | "noKey" | "keyRejected" | "unreachable";
const keyRejectedStatus = 401;

/** Whether the catalog answers and takes the key, asked afresh each time rather than from the cache. */
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
/** When each cached answer was asked for; only requests that name a `maxAgeMs` look at it. */
const cachedAt = new Map<string, number>();
/** A series gets a new episode while the app stays open for days; its airing answer is asked again after this long. */
const airingMaxAgeMs = 3 * 60 * 60 * 1000;

type Raw = Record<string, any>;

/** Connections to the catalog drop now and then; a dropped or rate-limited request is retried. */
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

function request<T>(path: string, params: Record<string, string | number> = {}, maxAgeMs = Infinity): Promise<T> {
  const query = new URLSearchParams({
    api_key: apiKeyOverride ?? import.meta.env.VITE_TMDB_API_KEY ?? "",
    language: catalog.language,
    include_adult: "false",
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
  });
  const url = `${apiBase}${path}?${query}`;

  const cached = cache.get(url);
  if (cached && Date.now() - (cachedAt.get(url) ?? 0) <= maxAgeMs) return cached as Promise<T>;

  const pending = fetchWithRetry(url);
  // A failed request must not poison the cache.
  pending.catch(() => cache.delete(url));
  // "Not found" is an ordinary answer (a title without a collection, a removed page), not a failure worth the journal.
  pending.catch((error) => {
    if (!(error instanceof Error && error.message === "tmdb_404")) report("catalog", "journal.catalog.failed", error);
  });
  cache.set(url, pending);
  cachedAt.set(url, Date.now());
  return pending as Promise<T>;
}

let regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** TMDB names countries in English only, so the localized name comes from the ISO code. */
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

/** Like `toItems`, but a title without a poster stays: looked up by name or id, it is still the title asked for. */
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

/** Keeps the first of the items that share a key. */
function uniqueBy<T>(items: T[], keyOf: (item: T) => string | number): T[] {
  const seen = new Set<string | number>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Who made the title: a film has directors, a series has creators. */
function directorsOf(raw: Raw, type: MediaType): Raw[] {
  return type === "movie" ? (raw.credits?.crew ?? []).filter((person: Raw) => person.job === "Director") : (raw.created_by ?? []);
}

const videoKinds: Record<string, TitleVideo["kind"]> = { Trailer: "trailer", Teaser: "teaser" };

/**
 * YouTube trailers and teasers, best first: in the catalog language before English, trailers
 * before teasers, official before fan uploads. A title with neither keeps one other video, so
 * there is still something to watch.
 */
function toVideos(results: Raw[] | undefined): TitleVideo[] {
  const language = catalog.language.slice(0, 2);
  // Each criterion outweighs all the ones after it.
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

/** Cast members counted towards taste: the leads, not the whole call sheet. */
const leadingCastCount = 5;

/**
 * Fewest votes a title needs to be listed in the catalog. Sorting by rating without a floor puts
 * titles with three votes of 10 on top; the other orders only need to drop empty entries.
 */
const discoverVoteFloor: Record<DiscoverSort, Record<MediaType, number>> = {
  popular: { movie: 30, tv: 15 },
  rating: { movie: 300, tv: 200 },
  newest: { movie: 20, tv: 10 },
};
/** A minimum rating only means something when enough people have voted. */
const ratedVoteFloor: Record<MediaType, number> = { movie: 100, tv: 50 };
const discoverSortField: Record<DiscoverSort, Record<MediaType, string>> = {
  popular: { movie: "popularity.desc", tv: "popularity.desc" },
  rating: { movie: "vote_average.desc", tv: "vote_average.desc" },
  newest: { movie: "primary_release_date.desc", tv: "first_air_date.desc" },
};
const discoverDateField: Record<MediaType, string> = { movie: "primary_release_date", tv: "first_air_date" };
const isoDateLength = "2000-01-01".length;
/** TMDB refuses to page a list any further than this. */
const discoverPageLimit = 500;

/** Anime is listed as series, the way the home page row defines it. */
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
  if (filters.kind === "anime") params.with_original_language = "ja";
  if (filters.country) params.with_origin_country = filters.country;
  if (filters.minRating > 0) params["vote_average.gte"] = filters.minRating;
  if (filters.yearFrom) params[`${dateField}.gte`] = `${filters.yearFrom}-01-01`;

  const lastDay = filters.yearTo ? `${filters.yearTo}-12-31` : "";
  // "Newest" means newest released: without a cap the list opens with films announced years ahead.
  const today = new Date().toISOString().slice(0, isoDateLength);
  const until = filters.sort === "newest" && (!lastDay || today < lastDay) ? today : lastDay;
  if (until) params[`${dateField}.lte`] = until;
  return params;
}

/** Talk shows and news list every guest as cast; an appearance there is not a role. */
const guestAppearanceGenreIds = [10767, 10763];
/** How the catalog names the "character" of someone appearing as themselves, in documentaries and award shows. */
const selfAppearancePattern = /^(self|himself|herself|themselves)\b/i;
/** A series has creators where a film has a director; a person's page lists both as their own work. */
const directingJobs = ["Director", "Creator"];

/** A person's credits as titles: with posters only, each title once, the most voted first. */
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

  /**
   * Titles of one kind found by name. `year` keeps those released (a series: first aired) that
   * year; `language` ("en-US") is the language their titles come back in, the catalog's own by
   * default. Unlike `search`, a title without a poster stays.
   */
  async searchByName(type: MediaType, query: string, options: { year?: number | null; language?: string } = {}): Promise<MediaItem[]> {
    const params: Record<string, string | number> = { query, page: 1 };
    if (options.year) params[type === "movie" ? "year" : "first_air_date_year"] = options.year;
    if (options.language) params.language = options.language;
    const data = await request<Raw>(`/search/${type}`, params);
    return toPlainItems(data.results, type);
  },

  /** What the catalog has under an IMDb id ("tt1375666"): one film or series as a rule, nothing when it does not know the id. */
  async findByImdbId(imdbId: string): Promise<MediaItem[]> {
    const data = await request<Raw>(`/find/${imdbId}`, { external_source: "imdb_id" });
    return [...toPlainItems(data.movie_results, "movie"), ...toPlainItems(data.tv_results, "tv")];
  },

  /** One title by its catalog id, without the cast, trailers and the rest of what its page loads. */
  async summary(type: MediaType, id: number): Promise<MediaItem> {
    const item = toItem(await request<Raw>(`/${type}/${id}`), type);
    if (!item) throw new Error("tmdb_bad_item");
    return item;
  },

  async details(type: MediaType, id: number): Promise<Details> {
    const raw = await request<Raw>(`/${type}/${id}`, {
      append_to_response: "credits,recommendations,videos,external_ids",
      // Trailers in the interface language where they exist, English ones otherwise.
      include_video_language: [...new Set([catalog.language.slice(0, 2), "en"])].join(","),
    });
    const base = toItem(raw, type);
    if (!base) throw new Error("tmdb_bad_item");

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
          episodeCount: season.episode_count,
          year: (season.air_date ?? "").slice(0, 4),
        }))
        // Specials (season 0) go after the regular seasons.
        .sort((a: SeasonInfo, b: SeasonInfo) => (a.seasonNumber || Infinity) - (b.seasonNumber || Infinity)),
      recommendations: toItems(raw.recommendations?.results, type).slice(0, 18),
      videos,
      trailerKey: videos[0]?.key ?? null,
      collection: raw.belongs_to_collection ? { id: raw.belongs_to_collection.id, name: raw.belongs_to_collection.name ?? "" } : null,
      imdbId: raw.external_ids?.imdb_id || raw.imdb_id || null,
    };
  },

  async taste(type: MediaType, id: number): Promise<TitleTaste> {
    const raw = await request<Raw>(`/${type}/${id}`, { append_to_response: "credits,recommendations,similar" });
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
    };
  },

  /** Well-rated titles of a genre, most voted first: the genre's essentials rather than this week's releases. */
  bestOfGenre: (type: MediaType, genreId: number) =>
    list(`/discover/${type}`, type, { with_genres: genreId, sort_by: "vote_count.desc", "vote_average.gte": 7, "vote_count.gte": 400 }),

  /** Films a person directed (not merely produced) or acted in. */
  async personFilms(personId: number, role: "director" | "cast"): Promise<MediaItem[]> {
    const raw = await request<Raw>(`/person/${personId}/movie_credits`);
    const credits: Raw[] = role === "director" ? (raw.crew ?? []).filter((credit: Raw) => credit.job === "Director") : (raw.cast ?? []);
    return toItems(credits, "movie");
  },

  /** One page of the catalog for a set of filters. */
  async discover(filters: DiscoverFilters, page: number): Promise<DiscoverPage> {
    const type = discoverType(filters.kind);
    const data = await request<Raw>(`/discover/${type}`, discoverParams(filters, page));
    return { items: toItems(data.results, type), totalPages: Math.min(data.total_pages ?? 1, discoverPageLimit) };
  },

  /** Genres a kind of title can be filtered by. Anime is animation already, so that genre is not offered for it. */
  async genres(kind: DiscoverKind): Promise<Genre[]> {
    const raw = await request<Raw>(`/genre/${discoverType(kind)}/list`);
    const genres: Genre[] = (raw.genres ?? []).map((genre: Raw) => ({ id: genre.id, name: genre.name }));
    return kind === "anime" ? genres.filter((genre) => genre.id !== animationGenreId) : genres;
  },

  /** Countries a title can come from, named and sorted in the catalog language. */
  async countries(): Promise<Country[]> {
    const raw = await request<Raw[]>("/configuration/countries");
    const collator = new Intl.Collator(catalog.language);
    return raw
      .map((country) => ({ code: country.iso_3166_1 as string, name: countryName(country.iso_3166_1, country.english_name) }))
      .sort((a, b) => collator.compare(a.name, b.name));
  },

  /** The films of a franchise in release order. */
  async collection(id: number): Promise<Collection> {
    const raw = await request<Raw>(`/collection/${id}`);
    const parts: CollectionPart[] = (raw.parts ?? []).flatMap((part: Raw) => {
      const item = toItem(part, "movie");
      return item ? [{ ...item, releaseDate: part.release_date ?? "" }] : [];
    });
    // ISO dates sort as text; a part without a date is not scheduled yet and goes last.
    const byRelease = (a: CollectionPart, b: CollectionPart) =>
      Number(!a.releaseDate) - Number(!b.releaseDate) || a.releaseDate.localeCompare(b.releaseDate);
    return { id: raw.id, name: raw.name ?? "", parts: parts.sort(byRelease) };
  },

  async person(id: number): Promise<Person> {
    const raw = await request<Raw>(`/person/${id}`, { append_to_response: "combined_credits" });
    // Biographies are rarely translated; the English one is better than an empty page.
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

  /** Genre names by id, for films and series together (the two lists mostly overlap). */
  async genreNames(): Promise<Map<number, string>> {
    const [movie, tv] = await Promise.all([request<Raw>("/genre/movie/list"), request<Raw>("/genre/tv/list")]);
    return new Map([...(tv.genres ?? []), ...(movie.genres ?? [])].map((genre: Raw) => [genre.id as number, genre.name as string]));
  },

  /** The titles the most people have rated: the ones a newcomer is likeliest to know. */
  mostVoted(kind: DiscoverKind, page: number): Promise<MediaItem[]> {
    const type = discoverType(kind);
    const params: Record<string, string | number> = { page, sort_by: "vote_count.desc" };
    if (kind === "anime") {
      params.with_genres = animationGenreId;
      params.with_original_language = "ja";
    }
    return list(`/discover/${type}`, type, params);
  },

  /** The last and the next episode of a series. A light request, unlike `details`, so a whole list of series can be asked about. */
  async airing(seriesId: number): Promise<SeriesAiring> {
    const raw = await request<Raw>(`/tv/${seriesId}`, {}, airingMaxAgeMs);
    const toEpisode = (episode: Raw | null | undefined): AiringEpisode | null =>
      episode
        ? {
            season: episode.season_number,
            episode: episode.episode_number,
            name: episode.name || t("common.episodeNumber", { episode: episode.episode_number }),
            airDate: episode.air_date ?? "",
          }
        : null;
    return { last: toEpisode(raw.last_episode_to_air), next: toEpisode(raw.next_episode_to_air) };
  },

  async season(seriesId: number, seasonNumber: number): Promise<Episode[]> {
    const raw = await request<Raw>(`/tv/${seriesId}/season/${seasonNumber}`);
    return (raw.episodes ?? []).map((episode: Raw) => ({
      season: seasonNumber,
      episode: episode.episode_number,
      name: episode.name || t("common.episodeNumber", { episode: episode.episode_number }),
      overview: episode.overview ?? "",
      still: episode.still_path ?? null,
      airDate: episode.air_date ?? "",
      runtimeMinutes: episode.runtime ?? null,
    }));
  },
};
