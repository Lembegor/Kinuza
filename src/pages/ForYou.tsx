import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PosterGrid } from "../components/Cards";
import { MoodChips } from "../components/home/MoodRecs";
import { useT } from "../lib/i18n";
import { key } from "../lib/taste";
import { moodOf, moodPicks, type Mood, type PickItem } from "../state/homeFeed";
import { useLibrary } from "../state/library";

const gridLimit = 60;
const skeletonCount = 18;

export default function ForYou() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const mood = moodOf(params.get("mood"));
  const dismissed = useLibrary((state) => state.dismissed);
  const tracked = useLibrary((state) => state.tracked);
  const [state, setState] = useState<{ id: string; items: PickItem[] | null; failed: boolean }>({ id: "", items: null, failed: false });

  useEffect(() => {
    let alive = true;
    setState({ id: mood.id, items: null, failed: false });
    moodPicks(mood, gridLimit).then(
      (items) => alive && setState({ id: mood.id, items, failed: false }),
      () => alive && setState({ id: mood.id, items: [], failed: true }),
    );
    return () => {
      alive = false;
    };
  }, [mood]);

  const items = useMemo(
    () => (state.id === mood.id && state.items ? state.items.filter((item) => !(key(item) in dismissed) && !(key(item) in tracked)) : null),
    [state, mood.id, dismissed, tracked],
  );
  const choose = (next: Mood) => setParams(next.id === "all" ? {} : { mood: next.id }, { replace: true });

  return (
    <div className="page for-you">
      <div className="page__head">
        <h1>{t("feed.forYou")}</h1>
      </div>
      <MoodChips active={mood} onChoose={choose} />
      {items === null ? (
        <div className="poster-grid">
          {Array.from({ length: skeletonCount }, (_, index) => (
            <div key={index} className="poster-card poster-card--skeleton" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="row__empty">{state.failed ? t("errors.catalog.network") : t("home.mood.empty")}</p>
      ) : (
        <PosterGrid items={items} />
      )}
    </div>
  );
}
