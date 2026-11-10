// TMDB client: catalog, search, details and episode lists, with an in-memory cache.

const apiBase = "https://api.themoviedb.org/3";
const imageBase = "https://image.tmdb.org/t/p";
const animationGenreId = 16;
const language = "ru-RU";
const maxRetries = 2;
const retryDelayMs = 600;

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
  isAnime: boolean;
}

export interface CastMember {
  id: number;
  name: string;
  character: string;
  photo: string | null;
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
  seasons: SeasonInfo[];
  recommendations: MediaItem[];
  trailerKey: string | null;
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

export function hasApiKey(): boolean {
  return Boolean(apiKeyOverride ?? import.meta.env.VITE_TMDB_API_KEY);
}

const cache = new Map<string, Promise<unknown>>();

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

function request<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const query = new URLSearchParams({
    api_key: apiKeyOverride ?? import.meta.env.VITE_TMDB_API_KEY ?? "",
    language,
    include_adult: "false",
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
  });
  const url = `${apiBase}${path}?${query}`;

  const cached = cache.get(url);
  if (cached) return cached as Promise<T>;

  const pending = fetchWithRetry(url);
  // A failed request must not poison the cache.
  pending.catch(() => cache.delete(url));
  cache.set(url, pending);
  return pending as Promise<T>;
}

const regionNames = new Intl.DisplayNames(["ru"], { type: "region" });

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
    isAnime: genreIds.includes(animationGenreId) && raw.original_language === "ja",
  };
}

function toItems(results: Raw[] | undefined, fallbackType?: MediaType): MediaItem[] {
  return (results ?? [])
    .map((raw) => toItem(raw, fallbackType))
    .filter((item): item is MediaItem => item !== null && Boolean(item.poster));
}

async function list(path: string, type?: MediaType, params: Record<string, string | number> = {}): Promise<MediaItem[]> {
  const data = await request<Raw>(path, params);
  return toItems(data.results, type);
}

export const tmdb = {
  trending: () => list("/trending/all/week"),
  popularMovies: () => list("/movie/popular", "movie"),
  topMovies: () => list("/movie/top_rated", "movie"),
  nowPlaying: () => list("/movie/now_playing", "movie", { region: "RU" }),
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

  async details(type: MediaType, id: number): Promise<Details> {
    const raw = await request<Raw>(`/${type}/${id}`, {
      append_to_response: "credits,recommendations,videos",
      include_video_language: "ru,en",
    });
    const base = toItem(raw, type);
    if (!base) throw new Error("tmdb_bad_item");

    const videos: Raw[] = raw.videos?.results ?? [];
    const trailer =
      videos.find((video) => video.site === "YouTube" && video.type === "Trailer") ??
      videos.find((video) => video.site === "YouTube");

    const runtime: number | null =
      type === "movie" ? raw.runtime || null : (raw.episode_run_time?.[0] ?? null);

    return {
      ...base,
      tagline: raw.tagline ?? "",
      genres: (raw.genres ?? []).map((genre: Raw) => genre.name),
      runtimeMinutes: runtime,
      countries: (raw.production_countries ?? []).map((country: Raw) => countryName(country.iso_3166_1, country.name)),
      cast: (raw.credits?.cast ?? []).slice(0, 14).map((person: Raw) => ({
        id: person.id,
        name: person.name,
        character: person.character ?? "",
        photo: person.profile_path ?? null,
      })),
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
      trailerKey: trailer?.key ?? null,
    };
  },

  async season(seriesId: number, seasonNumber: number): Promise<Episode[]> {
    const raw = await request<Raw>(`/tv/${seriesId}/season/${seasonNumber}`);
    return (raw.episodes ?? []).map((episode: Raw) => ({
      season: seasonNumber,
      episode: episode.episode_number,
      name: episode.name || `Серия ${episode.episode_number}`,
      overview: episode.overview ?? "",
      still: episode.still_path ?? null,
      airDate: episode.air_date ?? "",
      runtimeMinutes: episode.runtime ?? null,
    }));
  },
};
