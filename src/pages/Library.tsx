import { useMemo, useState } from "react";
import { ListVideo } from "lucide-react";
import { EmptyState, PosterGrid } from "../components/Cards";
import { plural } from "../lib/format";
import { entryToRef, useLibrary, watchedEpisodeCount, watchStatuses, type Progress, type TrackEntry, type WatchStatus } from "../state/library";

type Filter = WatchStatus | "all";
type Sort = "updated" | "rating" | "title";

const sorts: { id: Sort; label: string }[] = [
  { id: "updated", label: "Сначала недавние" },
  { id: "rating", label: "По моей оценке" },
  { id: "title", label: "По названию" },
];

const comparers: Record<Sort, (a: TrackEntry, b: TrackEntry) => number> = {
  updated: (a, b) => b.updatedAt - a.updatedAt,
  rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.updatedAt - a.updatedAt,
  title: (a, b) => a.title.localeCompare(b.title, "ru"),
};

/** "12 из 62 серий" for a series being watched; nothing when there is no progress to show. */
function episodeNote(entry: TrackEntry, progress: Record<string, Progress>): string | undefined {
  if (entry.type !== "tv") return undefined;
  const watched = watchedEpisodeCount(progress, entry.id);
  if (watched === 0) return undefined;
  if (!entry.totalEpisodes) return `${watched} ${plural(watched, "серия", "серии", "серий")}`;
  return `${watched} из ${entry.totalEpisodes} ${plural(entry.totalEpisodes, "серии", "серий", "серий")}`;
}

export default function Library() {
  const tracked = useLibrary((state) => state.tracked);
  const progress = useLibrary((state) => state.progress);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("updated");

  const entries = useMemo(() => Object.values(tracked), [tracked]);
  const counts = useMemo(() => {
    const result: Record<string, number> = { all: entries.length };
    for (const entry of entries) if (entry.status) result[entry.status] = (result[entry.status] ?? 0) + 1;
    return result;
  }, [entries]);

  const visible = useMemo(
    () =>
      entries
        .filter((entry) => filter === "all" || entry.status === filter)
        .sort(comparers[sort])
        .map((entry) => ({ ...entryToRef(entry), note: episodeNote(entry, progress) })),
    [entries, filter, sort, progress],
  );

  if (entries.length === 0) {
    return (
      <div className="page">
        <EmptyState
          icon={<ListVideo size={40} />}
          title="Список пока пуст"
          text="Откройте фильм или сериал и выберите статус — «Запланировано», «Смотрю», «Просмотрено». Всё, что вы начинаете смотреть, попадает сюда само."
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page__head">
        <h1>Мой список</h1>
        <select className="select select--large" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
          {sorts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      <div className="chips chips--scroll">
        <button className={`chip ${filter === "all" ? "is-active" : ""}`} onClick={() => setFilter("all")}>
          Все <small>{counts.all}</small>
        </button>
        {watchStatuses.map((status) => (
          <button
            key={status.id}
            className={`chip ${filter === status.id ? "is-active" : ""}`}
            onClick={() => setFilter(status.id)}
          >
            {status.label} <small>{counts[status.id] ?? 0}</small>
          </button>
        ))}
      </div>

      {visible.length > 0 ? (
        <PosterGrid items={visible} />
      ) : (
        <EmptyState icon={<ListVideo size={40} />} title="Здесь пока ничего нет" text="В этом статусе нет ни одного тайтла." />
      )}
    </div>
  );
}
