import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { SearchX, UserRound } from "lucide-react";
import { CatalogError, EmptyState, PosterGrid } from "../components/Cards";
import { useT, type MessageKey } from "../lib/i18n";
import { imageUrl, tmdb, type FoundPerson, type MediaItem } from "../lib/tmdb";
import { isWatched, titleKey, unitKey, useLibrary } from "../state/library";
import { useAsync } from "../lib/useAsync";

type Filter = "all" | "movie" | "tv" | "anime" | "people";

const filters: { id: Filter; label: MessageKey }[] = [
  { id: "all", label: "search.filter.all" },
  { id: "movie", label: "search.filter.movies" },
  { id: "tv", label: "search.filter.series" },
  { id: "anime", label: "search.filter.anime" },
  { id: "people", label: "search.filter.people" },
];

const peopleInAll = 8;

function matches(item: MediaItem, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "anime") return item.isAnime;
  return item.type === filter && !item.isAnime;
}

function readFilter(value: string | null): Filter {
  return filters.find((item) => item.id === value)?.id ?? "all";
}

function readPages(value: string | null): number {
  const pages = Number(value);
  return Number.isInteger(pages) && pages > 1 ? pages : 1;
}

function uniqueByKey<T>(items: T[], keyOf: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [keyOf(item), item])).values()];
}

function PeopleRow({ people }: { people: FoundPerson[] }) {
  return (
    <div className="cast search-people">
      {people.map((person) => {
        const photo = imageUrl(person.photo, "w185");
        return (
          <Link key={person.id} className="cast__person" to={`/person/${person.id}`} draggable={false}>
            <div className="cast__photo">{photo ? <img src={photo} alt="" loading="lazy" draggable={false} /> : <UserRound size={28} />}</div>
            <strong>{person.name}</strong>
            <span>{person.knownFor.join(", ")}</span>
          </Link>
        );
      })}
    </div>
  );
}

export default function Search() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") ?? "").trim();
  const filter = readFilter(params.get("type"));
  const pages = readPages(params.get("pages"));
  const hideWatched = params.get("unwatched") === "1";
  const tracked = useLibrary((state) => state.tracked);
  const progress = useLibrary((state) => state.progress);

  const results = useAsync(
    async () => {
      if (!query) return { items: [], people: [], hasMore: false };
      const loaded = await Promise.all(Array.from({ length: pages }, (_, index) => tmdb.searchEverything(query, index + 1)));
      return {
        items: uniqueByKey(
          loaded.flatMap((page) => page.items),
          (item) => `${item.type}:${item.id}`,
        ),
        people: uniqueByKey(
          loaded.flatMap((page) => page.people),
          (person) => String(person.id),
        ).sort((a, b) => b.popularity - a.popularity),
        hasMore: pages < (loaded[0]?.totalPages ?? 1),
      };
    },
    [query, pages],
    `search:${query}:${pages}`,
  );

  const change = (next: { type?: Filter; pages?: number; hideWatched?: boolean }) => {
    const search = new URLSearchParams();
    if (query) search.set("q", query);
    const type = next.type ?? filter;
    if (type !== "all") search.set("type", type);
    if (next.hideWatched ?? hideWatched) search.set("unwatched", "1");
    const count = next.pages ?? (next.type !== undefined ? 1 : pages);
    if (count > 1) search.set("pages", String(count));
    setParams(search, { replace: true });
  };

  const visible = useMemo(() => {
    if (filter === "people") return [];
    const seen = (item: MediaItem) => {
      const entry = tracked[titleKey(item.type, item.id)];
      if (entry?.status === "completed") return true;
      return item.type === "movie" && isWatched(progress[unitKey("movie", item.id)]);
    };
    return (results.data?.items ?? []).filter((item) => matches(item, filter) && !(hideWatched && seen(item)));
  }, [results.data, filter, hideWatched, tracked, progress]);
  const people = filter === "people" ? (results.data?.people ?? []) : filter === "all" ? (results.data?.people ?? []).slice(0, peopleInAll) : [];
  const nothing = visible.length === 0 && people.length === 0;

  return (
    <div className="page">
      <div className="page__head">
        <h1>{query ? t("search.query", { query }) : t("search.title")}</h1>
        <div className="chips">
          {filters.map((item) => (
            <button key={item.id} className={`chip ${filter === item.id ? "is-active" : ""}`} aria-pressed={filter === item.id} onClick={() => change({ type: item.id })}>
              {t(item.label)}
            </button>
          ))}
          {filter !== "people" && (
            <button className={`chip ${hideWatched ? "is-active" : ""}`} aria-pressed={hideWatched} onClick={() => change({ hideWatched: !hideWatched })}>
              {t("search.filter.hideWatched")}
            </button>
          )}
        </div>
      </div>

      {results.error ? (
        <CatalogError onRetry={results.reload} />
      ) : results.loading && !results.data ? (
        <div className="poster-grid">
          {Array.from({ length: 12 }, (_, index) => (
            <div key={index} className="poster-card poster-card--skeleton" />
          ))}
        </div>
      ) : nothing ? (
        <EmptyState
          icon={<SearchX size={40} />}
          title={query ? t("search.empty.title") : t("search.prompt.title")}
          text={query ? t("search.empty.text") : t("search.prompt.text")}
        />
      ) : (
        <>
          {people.length > 0 && (
            <section className="section section--first">
              {filter === "all" && (
                <div className="section__head">
                  <h2>{t("search.people")}</h2>
                </div>
              )}
              <PeopleRow people={people} />
            </section>
          )}
          {visible.length > 0 && (
            <section className={`section ${people.length === 0 ? "section--first" : ""}`}>
              {filter === "all" && people.length > 0 && (
                <div className="section__head">
                  <h2>{t("search.titles")}</h2>
                </div>
              )}
              <PosterGrid items={visible} />
            </section>
          )}
          {results.data?.hasMore && (
            <div className="browse-more">
              <button className="button button--large" disabled={results.loading} onClick={() => change({ pages: pages + 1 })}>
                {t("browse.more")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
