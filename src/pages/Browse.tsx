import { useEffect, useMemo, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronDown, RotateCcw, SearchX } from "lucide-react";
import { CatalogError, PosterCard } from "../components/Cards";
import { useT, type MessageKey } from "../lib/i18n";
import { tmdb, type Country, type DiscoverFilters, type DiscoverKind, type DiscoverSort, type MediaItem } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { useBrowse } from "../state/browse";

const kinds: { id: DiscoverKind; label: MessageKey }[] = [
  { id: "movie", label: "search.filter.movies" },
  { id: "tv", label: "search.filter.series" },
  { id: "anime", label: "search.filter.anime" },
];

const sorts: { id: DiscoverSort; label: MessageKey }[] = [
  { id: "popular", label: "browse.sort.popular" },
  { id: "rating", label: "browse.sort.rating" },
  { id: "newest", label: "browse.sort.newest" },
];

const defaultFilters: DiscoverFilters = {
  kind: "movie",
  genres: [],
  yearFrom: null,
  yearTo: null,
  country: "",
  minRating: 0,
  sort: "popular",
};

const ratingSteps = [5, 6, 7, 8, 9];
const earliestYear = 1900;
const pageSize = 20;
const majorCountries = ["US", "GB", "FR", "DE", "IT", "ES", "JP", "KR", "CN", "IN", "CA", "AU", "SE", "DK", "PL", "UA", "TR", "BR"];
const countryCodePattern = /^[A-Z]{2}$/;

function latestYear(): number {
  return new Date().getFullYear();
}

function readYear(value: string | null): number | null {
  const year = Number(value);
  return Number.isInteger(year) && year >= earliestYear && year <= latestYear() ? year : null;
}

function readFilters(params: URLSearchParams): DiscoverFilters {
  const years = [readYear(params.get("from")), readYear(params.get("to"))];
  const reversed = years[0] !== null && years[1] !== null && years[0] > years[1];
  const [yearFrom, yearTo] = reversed ? [years[1], years[0]] : years;
  const country = params.get("country") ?? "";
  const rating = Number(params.get("rating"));
  return {
    kind: kinds.find((kind) => kind.id === params.get("kind"))?.id ?? defaultFilters.kind,
    genres: (params.get("genres") ?? "")
      .split(",")
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0),
    yearFrom,
    yearTo,
    country: countryCodePattern.test(country) ? country : "",
    minRating: ratingSteps.includes(rating) ? rating : 0,
    sort: sorts.find((sort) => sort.id === params.get("sort"))?.id ?? defaultFilters.sort,
  };
}

function readPageCount(params: URLSearchParams): number {
  const pages = Number(params.get("pages"));
  return Number.isInteger(pages) && pages > 1 ? pages : 1;
}

function toSearch(filters: DiscoverFilters, pageCount = 1): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.kind !== defaultFilters.kind) params.set("kind", filters.kind);
  if (filters.genres.length > 0) params.set("genres", filters.genres.join(","));
  if (filters.yearFrom) params.set("from", String(filters.yearFrom));
  if (filters.yearTo) params.set("to", String(filters.yearTo));
  if (filters.country) params.set("country", filters.country);
  if (filters.minRating > 0) params.set("rating", String(filters.minRating));
  if (filters.sort !== defaultFilters.sort) params.set("sort", filters.sort);
  if (pageCount > 1) params.set("pages", String(pageCount));
  return params;
}

function withoutRepeats(items: MediaItem[]): MediaItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function CountryOptions({ countries }: { countries: Country[] }) {
  const { t } = useT();
  return (
    <>
      <optgroup label={t("browse.country.major")}>
        {countries
          .filter((country) => majorCountries.includes(country.code))
          .map((country) => (
            <option key={country.code} value={country.code}>
              {country.name}
            </option>
          ))}
      </optgroup>
      <optgroup label={t("browse.country.all")}>
        {countries.map((country) => (
          <option key={country.code} value={country.code}>
            {country.name}
          </option>
        ))}
      </optgroup>
    </>
  );
}

function FilterSelect({
  label,
  value,
  active,
  onChange,
  children,
}: {
  label: string;
  value: string | number;
  active: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <span className={`filter-select ${active ? "is-set" : ""}`}>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <ChevronDown size={15} />
    </span>
  );
}

export default function Browse() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const pageCount = readPageCount(params);

  const genreList = useAsync(async () => ({ kind: filters.kind, genres: await tmdb.genres(filters.kind) }), [filters.kind]);
  const genres = genreList.data?.kind === filters.kind ? genreList.data.genres : null;
  const countries = useAsync(tmdb.countries, []);

  const query = useMemo<DiscoverFilters | null>(() => {
    if (filters.genres.length === 0) return filters;
    if (!genres) return null;
    return { ...filters, genres: filters.genres.filter((id) => genres.some((genre) => genre.id === id)) };
  }, [filters, genres]);
  const queryKey = query ? toSearch(query).toString() : null;

  const results = useAsync(async () => {
    if (!query) return null;
    const pages = await Promise.all(Array.from({ length: pageCount }, (_, index) => tmdb.discover(query, index + 1)));
    return {
      queryKey,
      pageCount,
      items: withoutRepeats(pages.flatMap((page) => page.items)),
      hasMore: pageCount < pages[0].totalPages,
    };
  }, [queryKey, pageCount], `browse:${queryKey}:${pageCount}`);
  const shown = results.data && results.data.queryKey === queryKey ? results.data : null;

  const filterSearch = toSearch(filters).toString();
  useEffect(() => useBrowse.getState().remember(filterSearch), [filterSearch]);

  const update = (patch: Partial<DiscoverFilters>) => setParams(toSearch({ ...filters, ...patch }), { replace: true });
  const showMore = () => setParams(toSearch(filters, pageCount + 1), { replace: true });
  const reset = () => update({ ...defaultFilters, kind: filters.kind });

  const activeGenres = query?.genres ?? filters.genres;
  const toggleGenre = (id: number) =>
    update({ genres: activeGenres.includes(id) ? activeGenres.filter((genreId) => genreId !== id) : [...activeGenres, id] });

  const isNarrowed = toSearch({ ...filters, kind: defaultFilters.kind }).size > 0;
  const years = Array.from({ length: latestYear() - earliestYear + 1 }, (_, index) => latestYear() - index);
  const failed = Boolean(results.error || genreList.error);
  const retry = () => {
    if (genreList.error) genreList.reload();
    results.reload();
  };

  return (
    <div className="page">
      <div className="page__head">
        <h1>{t("browse.title")}</h1>
        <div className="chips">
          {kinds.map((kind) => (
            <button key={kind.id} className={`chip ${filters.kind === kind.id ? "is-active" : ""}`} onClick={() => update({ kind: kind.id })}>
              {t(kind.label)}
            </button>
          ))}
        </div>
      </div>

      <div className="filters">
        <FilterSelect label={t("browse.sort")} value={filters.sort} active={filters.sort !== defaultFilters.sort} onChange={(value) => update({ sort: value as DiscoverSort })}>
          {sorts.map((sort) => (
            <option key={sort.id} value={sort.id}>
              {t(sort.label)}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          label={t("browse.year.from")}
          value={filters.yearFrom ?? ""}
          active={filters.yearFrom !== null}
          onChange={(value) => update({ yearFrom: readYear(value) })}
        >
          <option value="">{t("browse.year.from")}</option>
          {years
            .filter((year) => !filters.yearTo || year <= filters.yearTo)
            .map((year) => (
              <option key={year} value={year}>
                {t("browse.year.fromValue", { year })}
              </option>
            ))}
        </FilterSelect>
        <FilterSelect
          label={t("browse.year.to")}
          value={filters.yearTo ?? ""}
          active={filters.yearTo !== null}
          onChange={(value) => update({ yearTo: readYear(value) })}
        >
          <option value="">{t("browse.year.to")}</option>
          {years
            .filter((year) => !filters.yearFrom || year >= filters.yearFrom)
            .map((year) => (
              <option key={year} value={year}>
                {t("browse.year.toValue", { year })}
              </option>
            ))}
        </FilterSelect>
        <FilterSelect label={t("browse.country")} value={filters.country} active={filters.country !== ""} onChange={(value) => update({ country: value })}>
          <option value="">{t("browse.country.any")}</option>
          {countries.data && <CountryOptions countries={countries.data} />}
        </FilterSelect>
        <FilterSelect
          label={t("browse.rating")}
          value={filters.minRating}
          active={filters.minRating > 0}
          onChange={(value) => update({ minRating: Number(value) })}
        >
          <option value={0}>{t("browse.rating.any")}</option>
          {ratingSteps.map((rating) => (
            <option key={rating} value={rating}>
              {t("browse.rating.from", { rating })}
            </option>
          ))}
        </FilterSelect>
        {isNarrowed && (
          <button className="filters__reset" onClick={reset}>
            <RotateCcw size={15} />
            {t("browse.reset")}
          </button>
        )}
      </div>

      <div className="chips filters__genres">
        {genres?.map((genre) => (
          <button
            key={genre.id}
            className={`chip chip--compact ${activeGenres.includes(genre.id) ? "is-active" : ""}`}
            aria-pressed={activeGenres.includes(genre.id)}
            onClick={() => toggleGenre(genre.id)}
          >
            {genre.name}
          </button>
        ))}
      </div>

      {failed ? (
        <CatalogError onRetry={retry} />
      ) : shown && shown.items.length === 0 ? (
        <div className="empty">
          <SearchX size={40} />
          <h2>{t("browse.empty.title")}</h2>
          <p>{t("browse.empty.text")}</p>
          <button className="button button--primary" onClick={reset}>
            {t("browse.empty.reset")}
          </button>
        </div>
      ) : (
        <>
          <div className="poster-grid">
            {shown?.items.map((item) => <PosterCard key={item.id} item={item} />)}
            {(!shown || results.loading) &&
              Array.from({ length: pageSize }, (_, index) => <div key={`skeleton-${index}`} className="poster-card poster-card--skeleton" />)}
          </div>
          {shown?.hasMore && !results.loading && (
            <div className="browse-more">
              <button className="button button--large" onClick={showMore}>
                {t("browse.more")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
