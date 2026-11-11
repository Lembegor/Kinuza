// The episode calendar: what the followed series air soon, and what they aired in the last two weeks.

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarDays, Check } from "lucide-react";
import { CatalogError, EmptyState } from "../components/Cards";
import { t, tn, useT, type MessageKey } from "../lib/i18n";
import { imageUrl } from "../lib/tmdb";
import { dayToDate, isEpisodeWatched, shiftDay, useEpisodeCalendar, type CalendarEpisode } from "../state/calendar";
import { statusLabel, useLibrary, type Progress, type TitleRef } from "../state/library";

type View = "upcoming" | "aired";

const views: { id: View; label: MessageKey }[] = [
  { id: "upcoming", label: "calendar.view.upcoming" },
  { id: "aired", label: "calendar.view.aired" },
];
const skeletonCardCount = 6;

/** A series' episodes of one day. A season released at once is one entry, not eight in a row. */
interface Entry {
  title: TitleRef;
  season: number;
  episodes: CalendarEpisode[];
}

interface Day {
  day: string;
  entries: Entry[];
}

function groupByDay(episodes: CalendarEpisode[]): Day[] {
  const days = new Map<string, Map<string, Entry>>();
  for (const episode of episodes) {
    const entries = days.get(episode.airDate) ?? new Map<string, Entry>();
    days.set(episode.airDate, entries);
    const key = `${episode.title.id}:${episode.season}`;
    const entry = entries.get(key) ?? { title: episode.title, season: episode.season, episodes: [] };
    entries.set(key, entry);
    entry.episodes.push(episode);
  }
  return [...days].map(([day, entries]) => ({ day, entries: [...entries.values()] }));
}

/** "Today", "Tomorrow" or "Yesterday" for the days that have a name. */
function relativeDayName(day: string, today: string): string | null {
  if (day === today) return t("calendar.today");
  if (day === shiftDay(today, 1)) return t("calendar.tomorrow");
  if (day === shiftDay(today, -1)) return t("calendar.yesterday");
  return null;
}

/**
 * Whether the catalog has a real name for the episode. Until someone enters one it says "Episode 5"
 * in whatever language, which only repeats the number already on the card.
 */
function hasOwnName(episode: CalendarEpisode): boolean {
  return !new RegExp(`^\\p{L}+\\s+${episode.episode}$`, "u").test(episode.name.trim());
}

function episodesLabel(entry: Entry): string {
  const [first] = entry.episodes;
  const last = entry.episodes[entry.episodes.length - 1];
  return first === last
    ? t("common.seasonEpisode", { season: entry.season, episode: first.episode })
    : t("calendar.episodeRange", { season: entry.season, first: first.episode, last: last.episode });
}

function EpisodeCard({ entry, today, progress }: { entry: Entry; today: string; progress: Record<string, Progress> }) {
  const { t, tn } = useT();
  const navigate = useNavigate();
  const { title, episodes } = entry;
  const poster = imageUrl(title.poster, "w185");
  const unwatched = episodes.filter((episode) => !isEpisodeWatched(episode, progress)).length;
  const aired = episodes[0].airDate <= today;
  const named = episodes.length === 1 && hasOwnName(episodes[0]);

  return (
    <button className="calendar-card" onClick={() => navigate(`/title/tv/${title.id}`)}>
      <div className="calendar-card__art">{poster && <img src={poster} alt="" loading="lazy" draggable={false} />}</div>
      <div className="calendar-card__body">
        <div className="calendar-card__title">{title.title}</div>
        <div className="calendar-card__episode">{episodesLabel(entry)}</div>
        <div className="calendar-card__name">{named ? episodes[0].name : episodes.length > 1 ? tn("common.episodes", episodes.length) : ""}</div>
      </div>
      {unwatched === 0 ? (
        <span className="calendar-card__watched" title={t("calendar.watched")}>
          <Check size={16} />
        </span>
      ) : aired ? (
        <span className="calendar-card__new">{unwatched === 1 ? t("calendar.new") : tn("calendar.new.count", unwatched)}</span>
      ) : null}
    </button>
  );
}

function DaySection({ day, today, progress, locale }: { day: Day; today: string; progress: Record<string, Progress>; locale: string }) {
  const { t } = useT();
  const relative = relativeDayName(day.day, today);
  const date = new Intl.DateTimeFormat(locale, { weekday: "long", day: "numeric", month: "long" }).format(dayToDate(day.day));
  return (
    <section className={`calendar-day ${day.day === today ? "is-today" : ""}`}>
      <h2 className="calendar-day__head">
        {relative && <strong>{relative}</strong>}
        <span>{date}</span>
      </h2>
      {day.entries.length > 0 ? (
        <div className="calendar-day__list">
          {day.entries.map((entry) => (
            <EpisodeCard key={`${entry.title.id}:${entry.season}`} entry={entry} today={today} progress={progress} />
          ))}
        </div>
      ) : (
        <p className="calendar-day__empty">{t("calendar.today.empty")}</p>
      )}
    </section>
  );
}

export default function CalendarPage() {
  const { t, locale } = useT();
  const calendar = useEpisodeCalendar();
  const progress = useLibrary((state) => state.progress);
  const [chosenView, setChosenView] = useState<View | null>(null);
  const { today, episodes } = calendar;

  const upcoming = useMemo(() => groupByDay((episodes ?? []).filter((episode) => episode.airDate >= today)), [episodes, today]);
  // What came out most recently is what the user is likeliest to be after.
  const aired = useMemo(() => groupByDay((episodes ?? []).filter((episode) => episode.airDate <= today)).reverse(), [episodes, today]);
  const newCount = useMemo(
    () => (episodes ?? []).filter((episode) => episode.airDate <= today && !isEpisodeWatched(episode, progress)).length,
    [episodes, today, progress],
  );

  // Until the user picks a tab, the one that has something to show is open.
  const view = chosenView ?? (upcoming.length === 0 && aired.length > 0 ? "aired" : "upcoming");
  const days = view === "aired" ? aired : upcoming;
  // Today leads the upcoming days even when nothing airs, so the list has a fixed point to read from.
  const shownDays = view === "upcoming" && days.length > 0 && days[0].day !== today ? [{ day: today, entries: [] }, ...days] : days;

  if (calendar.followed === 0 && episodes !== null) {
    return (
      <div className="page">
        <EmptyState
          icon={<CalendarDays size={40} />}
          title={t("calendar.empty.title")}
          // The statuses are called what the list itself calls them.
          text={t("calendar.empty.text", { watching: statusLabel("watching"), planned: statusLabel("planned") })}
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page__head">
        <h1>{t("calendar.title")}</h1>
        <div className="chips">
          {views.map((item) => (
            <button key={item.id} className={`chip ${view === item.id ? "is-active" : ""}`} aria-pressed={view === item.id} onClick={() => setChosenView(item.id)}>
              {t(item.label)}
              {item.id === "aired" && newCount > 0 && (
                <small className="calendar-new-count" title={tn("calendar.new.count", newCount)}>
                  {newCount}
                </small>
              )}
            </button>
          ))}
        </div>
      </div>

      {episodes === null ? (
        <div className="calendar-day__list">
          {Array.from({ length: skeletonCardCount }, (_, index) => (
            <div key={index} className="calendar-card calendar-card--skeleton" />
          ))}
        </div>
      ) : calendar.error ? (
        <CatalogError onRetry={calendar.reload} />
      ) : shownDays.length > 0 ? (
        shownDays.map((day) => <DaySection key={day.day} day={day} today={today} progress={progress} locale={locale} />)
      ) : (
        <EmptyState
          icon={<CalendarDays size={40} />}
          title={t(view === "aired" ? "calendar.aired.empty.title" : "calendar.upcoming.empty.title")}
          text={t(view === "aired" ? "calendar.aired.empty.text" : "calendar.upcoming.empty.text")}
        />
      )}
    </div>
  );
}
