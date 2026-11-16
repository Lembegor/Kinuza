import { useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Dices, Laugh, LoaderCircle, Popcorn, Sparkles, Timer, Tv, Zap, type LucideIcon } from "lucide-react";
import { PosterRow, type CardItem, type DismissDetail } from "../Cards";
import { useT } from "../../lib/i18n";
import { key } from "../../lib/taste";
import { moods, useMoodPicks, type Mood } from "../../state/homeFeed";
import type { TitleRef } from "../../state/library";

const icons: Record<string, LucideIcon> = { popcorn: Popcorn, tv: Tv, laugh: Laugh, zap: Zap, sparkles: Sparkles, timer: Timer };

export function MoodChips({ active, onChoose, onSurprise, rolling = false }: { active: Mood; onChoose: (mood: Mood) => void; onSurprise?: () => void; rolling?: boolean }) {
  const { t } = useT();
  return (
    <div className="chips chips--scroll home-moods">
      <div className="home-moods__group" role="radiogroup" aria-label={t("home.mood.label")}>
        {moods.map((mood) => {
          const Icon = icons[mood.icon];
          const on = mood.id === active.id;
          return (
            <button key={mood.id} role="radio" aria-checked={on} className={`chip ${on ? "is-active" : ""}`} onClick={() => onChoose(mood)}>
              {Icon && <Icon size={15} />}
              {t(mood.labelKey)}
            </button>
          );
        })}
      </div>
      {onSurprise && (
        <button className="chip home-moods__surprise" onClick={onSurprise} disabled={rolling} aria-busy={rolling}>
          {rolling ? <LoaderCircle size={15} className="spin" /> : <Dices size={15} />}
          {t("home.mood.surprise")}
        </button>
      )}
    </div>
  );
}

export function MoodRecs({
  mood,
  onMood,
  baseItems,
  skip,
  moodSkip,
  generation,
  onDismiss,
  onSurprise,
  rolling,
  menu,
  title,
}: {
  mood: Mood;
  onMood: (mood: Mood) => void;
  baseItems: CardItem[] | null | undefined;
  skip: Set<string>;
  moodSkip: Set<string>;
  generation: number;
  onDismiss: (item: TitleRef, detail: DismissDetail) => void;
  onSurprise: (shown: CardItem[] | null) => void;
  rolling: boolean;
  menu?: ReactNode;
  title?: string;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const filtered = mood.id !== "all";
  const fetching = filtered || baseItems === undefined;
  const picks = useMoodPicks(mood, fetching, generation);
  const items = useMemo(() => {
    const source = fetching ? picks.items : baseItems;
    const avoid = fetching ? moodSkip : skip;
    return source ? source.filter((item) => !avoid.has(key(item))) : null;
  }, [fetching, picks.items, baseItems, skip, moodSkip]);
  if (!fetching && baseItems && baseItems.length === 0) return null;
  return (
    <PosterRow
      title={title ?? t("feed.forYou")}
      aside={filtered ? <span className="row__sub">{t(mood.labelKey).toLowerCase()}</span> : undefined}
      lead={<MoodChips active={mood} onChoose={onMood} onSurprise={() => onSurprise(items)} rolling={rolling} />}
      items={items}
      onDismiss={onDismiss}
      rowId={fetching ? undefined : "for-you"}
      more={{ label: t("home.more"), onClick: () => navigate(`/for-you${filtered ? `?mood=${mood.id}` : ""}`) }}
      menu={menu}
      empty={<p className="row__empty">{t("home.mood.empty")}</p>}
    />
  );
}
