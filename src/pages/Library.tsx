import { useMemo } from "react";
import { Bookmark } from "lucide-react";
import { EmptyState, PosterGrid } from "../components/Cards";
import { titleKey, useLibrary, type TitleRef } from "../state/library";

export default function Library() {
  const saved = useLibrary((state) => state.saved);
  const progress = useLibrary((state) => state.progress);

  const shelf = useMemo(() => Object.values(saved).sort((a, b) => b.addedAt - a.addedAt), [saved]);

  // One entry per title, most recently watched first.
  const history = useMemo(() => {
    const seen = new Map<string, { title: TitleRef; updatedAt: number }>();
    for (const item of Object.values(progress)) {
      const key = titleKey(item.title.type, item.title.id);
      const existing = seen.get(key);
      if (!existing || existing.updatedAt < item.updatedAt) seen.set(key, { title: item.title, updatedAt: item.updatedAt });
    }
    return [...seen.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((entry) => entry.title);
  }, [progress]);

  if (shelf.length === 0 && history.length === 0) {
    return (
      <div className="page">
        <EmptyState
          icon={<Bookmark size={40} />}
          title="Полка пока пустая"
          text="Откройте фильм или сериал и нажмите «На полку» — он появится здесь. Сюда же попадает всё, что вы смотрели."
        />
      </div>
    );
  }

  return (
    <div className="page">
      {shelf.length > 0 && (
        <>
          <div className="page__head">
            <h1>Моя полка</h1>
          </div>
          <PosterGrid items={shelf} />
        </>
      )}
      {history.length > 0 && (
        <>
          <div className="page__head">
            <h1>История просмотра</h1>
          </div>
          <PosterGrid items={history} />
        </>
      )}
    </div>
  );
}
