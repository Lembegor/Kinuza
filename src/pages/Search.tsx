import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SearchX } from "lucide-react";
import { CatalogError, EmptyState, PosterGrid } from "../components/Cards";
import { tmdb, type MediaItem } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";

type Filter = "all" | "movie" | "tv" | "anime";

const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "Всё" },
  { id: "movie", label: "Фильмы" },
  { id: "tv", label: "Сериалы" },
  { id: "anime", label: "Аниме" },
];

function matches(item: MediaItem, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "anime") return item.isAnime;
  return item.type === filter && !item.isAnime;
}

export default function Search() {
  const [params] = useSearchParams();
  const query = (params.get("q") ?? "").trim();
  const [filter, setFilter] = useState<Filter>("all");
  const results = useAsync(() => (query ? tmdb.search(query) : Promise.resolve([])), [query]);

  const visible = useMemo(() => (results.data ?? []).filter((item) => matches(item, filter)), [results.data, filter]);

  return (
    <div className="page">
      <div className="page__head">
        <h1>{query ? `«${query}»` : "Поиск"}</h1>
        <div className="chips">
          {filters.map((item) => (
            <button
              key={item.id}
              className={`chip ${filter === item.id ? "is-active" : ""}`}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
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
          title={query ? "Ничего не нашлось" : "Введите название"}
          text={query ? "Попробуйте другое написание или оригинальное название." : "Поиск работает по фильмам, сериалам и аниме."}
        />
      )}
    </div>
  );
}
