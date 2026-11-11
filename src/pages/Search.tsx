import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SearchX } from "lucide-react";
import { CatalogError, EmptyState, PosterGrid } from "../components/Cards";
import { useT, type MessageKey } from "../lib/i18n";
import { tmdb, type MediaItem } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";

type Filter = "all" | "movie" | "tv" | "anime";

const filters: { id: Filter; label: MessageKey }[] = [
  { id: "all", label: "search.filter.all" },
  { id: "movie", label: "search.filter.movies" },
  { id: "tv", label: "search.filter.series" },
  { id: "anime", label: "search.filter.anime" },
];

function matches(item: MediaItem, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "anime") return item.isAnime;
  return item.type === filter && !item.isAnime;
}

export default function Search() {
  const { t } = useT();
  const [params] = useSearchParams();
  const query = (params.get("q") ?? "").trim();
  const [filter, setFilter] = useState<Filter>("all");
  const results = useAsync(() => (query ? tmdb.search(query) : Promise.resolve([])), [query]);

  const visible = useMemo(() => (results.data ?? []).filter((item) => matches(item, filter)), [results.data, filter]);

  return (
    <div className="page">
      <div className="page__head">
        <h1>{query ? t("search.query", { query }) : t("search.title")}</h1>
        <div className="chips">
          {filters.map((item) => (
            <button
              key={item.id}
              className={`chip ${filter === item.id ? "is-active" : ""}`}
              onClick={() => setFilter(item.id)}
            >
              {t(item.label)}
            </button>
          ))}
        </div>
      </div>

      {results.error ? (
        <CatalogError onRetry={results.reload} />
      ) : results.loading ? (
        <div className="poster-grid">
          {Array.from({ length: 12 }, (_, index) => (
            <div key={index} className="poster-card poster-card--skeleton" />
          ))}
        </div>
      ) : visible.length > 0 ? (
        <PosterGrid items={visible} />
      ) : (
        <EmptyState
          icon={<SearchX size={40} />}
          title={query ? t("search.empty.title") : t("search.prompt.title")}
          text={query ? t("search.empty.text") : t("search.prompt.text")}
        />
      )}
    </div>
  );
}
