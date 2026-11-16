import { useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useT } from "../../lib/i18n";
import { imageUrl } from "../../lib/tmdb";
import { dayToDate, shiftDay, type CalendarEpisode } from "../../state/calendar";

const weekDays = 7;
const perDay = 3;

export function WeekStrip({ episodes, today, menu }: { episodes: CalendarEpisode[] | null; today: string; menu?: ReactNode }) {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const days = useMemo(() => {
    const list = Array.from({ length: weekDays }, (_, index) => ({ day: shiftDay(today, index), episodes: [] as CalendarEpisode[] }));
    for (const episode of episodes ?? []) {
      const slot = list.find((entry) => entry.day === episode.airDate);
      if (slot) slot.episodes.push(episode);
    }
    return list;
  }, [episodes, today]);
  if (!episodes || !days.some((entry) => entry.episodes.length > 0)) return null;

  const dayName = (day: string, index: number) => {
    if (index === 0) return t("home.week.today");
    if (index === 1) return t("home.week.tomorrow");
    return dayToDate(day).toLocaleDateString(locale, { weekday: "short" });
  };

  return (
    <section className="row home-week">
      <div className="row__head">
        <h2>{t("home.row.week")}</h2>
        <div className="row__aside">
          <span className="row__sub">{t("home.week.sub")}</span>
        </div>
        <div className="row__end">
          <button className="row__more" onClick={() => navigate("/calendar")}>
            {t("shell.nav.calendar")}
          </button>
          {menu}
        </div>
      </div>
      <ol className="home-week__days">
        {days.map((entry, index) => (
          <li key={entry.day} className={`home-week__day ${index === 0 ? "is-today" : ""} ${entry.episodes.length === 0 ? "is-empty" : ""}`}>
            <div className="home-week__date">
              <span>{dayName(entry.day, index)}</span>
              <span>{dayToDate(entry.day).getDate()}</span>
            </div>
            {entry.episodes.length === 0 ? (
              <p className="home-week__none">{t("home.week.none")}</p>
            ) : (
              <>
                {entry.episodes.slice(0, perDay).map((episode) => (
                  <button
                    key={`${episode.title.id}:${episode.season}:${episode.episode}`}
                    className="home-week__episode"
                    onClick={() => navigate(`/title/tv/${episode.title.id}?s=${episode.season}`)}
                  >
                    {imageUrl(episode.poster, "w185") ? <img src={imageUrl(episode.poster, "w185") ?? undefined} alt="" loading="lazy" draggable={false} /> : <span className="home-week__blank" />}
                    <span className="home-week__text">
                      <b>{episode.title.title}</b>
                      <span>{t("common.seasonEpisode", { season: episode.season, episode: episode.episode })}</span>
                    </span>
                  </button>
                ))}
                {entry.episodes.length > perDay && (
                  <button className="home-week__more" onClick={() => navigate("/calendar")}>
                    {t("home.week.more", { count: entry.episodes.length - perDay })}
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
