import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronDown, Clock, FileUp, Info, Pause, Pencil, X } from "lucide-react";
import { Avatar } from "../components/ProfileButton";
import { ProfileEdit } from "../components/profile/ProfileEdit";
import { FriendsTab } from "../components/social/FriendsTab";
import { useAccount } from "../state/account";
import { ProfileHistory, noteOf } from "../components/profile/ProfileHistory";
import { YearRecap, recapYears } from "../components/profile/YearRecap";
import { useT } from "../lib/i18n";
import { allTime, buildHistory, dayKey, kindOf, kinds, overview, sinceDate, type Kind, type Ledger, type Overview, type Period } from "../lib/profileStats";
import {
  formatDaysHours,
  formatHoursShort,
  formatMonth,
  formatNumber,
  formatSeconds,
  kindLabels,
  languageName,
  monthNameStandalone,
  parseDay,
} from "../lib/profileFormat";
import { imageUrl, tmdb } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { useLibrary, watchedEpisodeCount } from "../state/library";
import { useProfile } from "../state/profile";
import { fillRuntimes, useLedger } from "../state/stats";
import { useSettings } from "../state/settings";

type PeriodId = "all" | "year" | "month";

function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

const heatWeeks = 53;
const genreLimit = 6;
const sideLimit = 6;

function periodOf(id: PeriodId, now: number): Period {
  const date = new Date(now);
  if (id === "year") return { from: new Date(date.getFullYear(), 0, 1).getTime(), to: new Date(date.getFullYear() + 1, 0, 1).getTime() };
  if (id === "month") return { from: new Date(date.getFullYear(), date.getMonth(), 1).getTime(), to: new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime() };
  return allTime;
}

function ProfileHeader({ ledger, onEdit }: { ledger: Ledger | null; onEdit: () => void }) {
  const { t, tn, locale } = useT();
  const name = useProfile((state) => state.name);
  const cover = useProfile((state) => state.cover);
  const paused = useProfile((state) => state.historyPaused);
  const tracked = useLibrary((state) => state.tracked);
  const onboardedAt = useLibrary((state) => state.onboardedAt);
  const since = ledger ? sinceDate(ledger.input, onboardedAt) : null;
  const backdrop = cover ? tracked[cover]?.backdrop : null;
  const signedIn = useAccount((state) => state.phase === "signedIn");
  const sinceText = since ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(new Date(since)) : null;
  return (
    <header className="profile-head">
      {backdrop && <img className="profile-head__cover" src={imageUrl(backdrop, "w1280") ?? undefined} alt="" draggable={false} />}
      <div className="profile-head__shade" />
      <button className="profile-head__avatar" aria-label={t("profile.edit.title")} onClick={onEdit}>
        <Avatar size={76} />
      </button>
      <div className="profile-head__text">
        <h1>{name || t("profile.defaultName")}</h1>
        <p>
          {sinceText && <span>{t("profile.since", { date: sinceText })}</span>}
          {Object.keys(tracked).length > 0 && <span>{tn("profile.titles", Object.keys(tracked).length)}</span>}
          <span>{signedIn ? t("profile.cloudSynced") : t("profile.localOnly")}</span>
          {paused && (
            <span className="profile-head__paused">
              <Pause size={11} fill="currentColor" />
              {t("profile.paused.badge")}
            </span>
          )}
        </p>
      </div>
      <button className="button" onClick={onEdit}>
        <Pencil size={15} />
        {t("profile.edit.button")}
      </button>
    </header>
  );
}

function TimeCard({ data, kind, onKind }: { data: Overview; kind: Kind | null; onKind: (kind: Kind | null) => void }) {
  const { t, tn } = useT();
  const total = Math.max(1, kinds.reduce((sum, item) => sum + data.byKind[item].seconds, 0));
  const days = formatDaysHours(data.seconds);
  return (
    <section className="profile-card profile-time">
      <div className="profile-card__label">{t("profile.time.label")}</div>
      <div className="profile-time__main">
        <strong>{formatHoursShort(data.seconds)}</strong>
        <div>
          {days && <span>{days}</span>}
          {data.estimated > 0 && (
            <span className="profile-time__estimate" title={t("profile.time.estimateHint")}>
              {t("profile.time.estimate", { time: formatHoursShort(data.estimated) })}
              <Info size={13} />
            </span>
          )}
          {data.missingRuntime > 0 && <span className="profile-time__estimate">{tn("profile.time.missing", data.missingRuntime)}</span>}
        </div>
      </div>
      <div className="profile-time__bar" role="img" aria-label={kinds.map((item) => `${t(kindLabels[item])} ${formatSeconds(data.byKind[item].seconds)}`).join(", ")}>
        {kinds.map((item) =>
          data.byKind[item].seconds > 0 ? (
            <i key={item} className={`kind-${item}`} style={{ flexGrow: data.byKind[item].seconds / total }} />
          ) : null,
        )}
      </div>
      <div className="profile-time__legend">
        {kinds.filter((item) => item === kind || data.byKind[item].seconds > 0 || data.byKind[item].items > 0).map((item) => (
          <button
            key={item}
            className={`profile-time__kind ${kind === item ? "is-active" : ""} ${kind !== null && kind !== item ? "is-dim" : ""}`}
            aria-pressed={kind === item}
            title={kind === item ? t("profile.kind.clear") : t("profile.kind.only", { kind: t(kindLabels[item]) })}
            onClick={() => onKind(kind === item ? null : item)}
          >
            <i className={`dot kind-${item}`} />
            <span>{t(kindLabels[item])}</span>
            <b>{formatHoursShort(data.byKind[item].seconds)}</b>
            <small>
              {item === "movie" ? tn("profile.count.movies", data.byKind[item].titles) : tn("common.episodes", data.byKind[item].items)}
            </small>
          </button>
        ))}
      </div>
    </section>
  );
}

function Counters({ data, period }: { data: Overview; period: PeriodId }) {
  const { t, tn } = useT();
  const navigate = useNavigate();
  const status = useLibrary((state) => state.tracked);
  const completedSeries = useMemo(
    () => Object.entries(status).filter(([key, entry]) => key.startsWith("tv:") && entry.status === "completed").length,
    [status],
  );
  return (
    <section className="profile-counters">
      <button className="profile-card profile-counter" onClick={() => navigate("/library?status=completed")}>
        <strong>{formatNumber(data.movies)}</strong>
        <span>{tn("profile.count.moviesWord", data.movies)}</span>
      </button>
      <button className="profile-card profile-counter" onClick={() => navigate("/profile/history")}>
        <strong>{formatNumber(data.episodes)}</strong>
        <span>
          {tn("profile.count.episodesWord", data.episodes)}
          {period === "all" && completedSeries > 0 && ` · ${tn("profile.count.completedSeries", completedSeries)}`}
        </span>
      </button>
      <div className="profile-card profile-counter">
        <strong>{data.rating.count > 0 ? formatNumber(data.rating.mean, 1) : "-"}</strong>
        <span>{data.rating.count > 0 ? tn("profile.count.rating", data.rating.count) : t("profile.count.noRatings")}</span>
      </div>
      <button className="profile-card profile-counter" onClick={() => navigate("/library?status=planned")}>
        <strong>{data.plannedSeconds > 0 ? formatHoursShort(data.plannedSeconds) : "-"}</strong>
        <span>
          {t("profile.count.planned")}
          {data.plannedUnknown > 0 && ` · ${tn("profile.count.plannedUnknown", data.plannedUnknown)}`}
        </span>
      </button>
    </section>
  );
}

function Heatmap({ data, now }: { data: Overview; now: number }) {
  const { t, tn, locale } = useT();
  const navigate = useNavigate();
  const cells = useMemo(() => {
    const end = new Date(now);
    const mondayOffset = (end.getDay() + 6) % 7;
    const lastMonday = new Date(end.getFullYear(), end.getMonth(), end.getDate() - mondayOffset);
    const start = new Date(lastMonday.getFullYear(), lastMonday.getMonth(), lastMonday.getDate() - (heatWeeks - 1) * 7);
    const values = [...data.days.values()].filter((value) => value > 0).sort((a, b) => a - b);
    const quantile = (share: number) => values[Math.min(values.length - 1, Math.floor(values.length * share))] ?? 0;
    const steps = [quantile(0.25), quantile(0.5), quantile(0.75)];
    const list: { day: string; level: number; seconds: number; future: boolean; month: number }[] = [];
    for (let index = 0; index < heatWeeks * 7; index++) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
      const day = dayKey(date.getTime());
      const seconds = data.days.get(day) ?? 0;
      const level = !data.days.has(day) ? 0 : seconds <= steps[0] ? 1 : seconds <= steps[1] ? 2 : seconds <= steps[2] ? 3 : 4;
      list.push({ day, level, seconds, future: date.getTime() > now, month: date.getMonth() });
    }
    return list;
  }, [data.days, now]);
  const weekday = (index: number) => new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 1 + index));
  const monthLabels = cells
    .filter((cell, index) => index % 7 === 0 && (index === 0 || cells[index - 7].month !== cell.month))
    .map((cell) => ({ week: cells.indexOf(cell) / 7, label: formatMonth(cell.day.slice(0, 7), "short") }));
  return (
    <section className="profile-card profile-heat">
      <div className="profile-card__head">
        <h2>{t("profile.heat.title")}</h2>
        <span>
          {data.longestStreak > 1 && tn("profile.heat.streak", data.longestStreak)}
          {data.longestStreak > 1 && data.activeDays > 0 && " · "}
          {data.activeDays > 0 && tn("profile.heat.active", data.activeDays)}
        </span>
      </div>
      <div className="profile-heat__grid" role="img" aria-label={t("profile.heat.title")}>
        {[0, 2, 4, 6].map((index) => (
          <span key={index} className="profile-heat__day" style={{ gridRow: index + 2 }} aria-hidden="true">
            {weekday(index)}
          </span>
        ))}
        {monthLabels.map((item) => (
          <span key={`${item.week}-${item.label}`} className="profile-heat__month" style={{ gridColumn: `${item.week + 2} / span 3` }}>
            {item.label}
          </span>
        ))}
        {cells.map((cell, index) => (
          <button
            key={cell.day}
            className={`profile-heat__cell level-${cell.level} ${cell.future ? "is-future" : ""}`}
            style={{ gridColumn: Math.floor(index / 7) + 2, gridRow: (index % 7) + 2 }}
            title={`${new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(parseDay(cell.day))}${cell.level > 0 ? ` · ${formatSeconds(cell.seconds)}` : ""}`}
            tabIndex={cell.level > 0 ? 0 : -1}
            disabled={cell.level === 0}
            onClick={() => navigate(`/profile/history?day=${cell.day}`)}
          />
        ))}
      </div>
    </section>
  );
}

function MonthChart({ data }: { data: Overview }) {
  const { t } = useT();
  const peak = Math.max(1, ...data.months.map(({ totals }) => totals.movie + totals.tv + totals.anime));
  const empty = data.months.every(({ totals }) => totals.movie + totals.tv + totals.anime === 0);
  return (
    <section className="profile-card profile-chart">
      <div className="profile-card__head">
        <h2>{t("profile.months.title")}</h2>
        {empty ? null : <span>{t("profile.months.peak", { time: formatHoursShort(peak) })}</span>}
      </div>
      {empty ? (
        <p className="profile-card__empty">{t("profile.months.empty")}</p>
      ) : (
        <div className="profile-bars">
          {data.months.map(({ month, totals }) => {
            const sum = totals.movie + totals.tv + totals.anime;
            return (
              <div key={month} className="profile-bars__column" title={`${formatMonth(month, "long", true)}: ${formatSeconds(sum)}`}>
                <div className="profile-bars__stack" style={{ height: `${(sum / peak) * 100}%` }}>
                  {(["anime", "tv", "movie"] as Kind[]).map((item) =>
                    totals[item] > 0 ? <i key={item} className={`kind-${item}`} style={{ flexGrow: totals[item] }} /> : null,
                  )}
                </div>
                <span>{formatMonth(month, "short")}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Ratings({ data }: { data: Overview }) {
  const { t } = useT();
  const peak = Math.max(1, ...data.rating.histogram);
  const top = data.rating.histogram.indexOf(Math.max(...data.rating.histogram));
  const versus = data.rating.vsCommunity;
  return (
    <section className="profile-card profile-chart">
      <div className="profile-card__head">
        <h2>{t("profile.ratings.title")}</h2>
        {versus !== null && Math.abs(versus) >= 0.1 && (
          <span>{versus > 0 ? t("profile.ratings.kinder", { value: formatNumber(versus, 1) }) : t("profile.ratings.stricter", { value: formatNumber(-versus, 1) })}</span>
        )}
      </div>
      {data.rating.count < 5 ? (
        <p className="profile-card__empty">{t("profile.ratings.few")}</p>
      ) : (
        <div className="profile-bars profile-bars--ratings">
          {data.rating.histogram.map((count, index) => (
            <div key={index} className="profile-bars__column" title={`${index + 1}: ${count}`}>
              <div className={`profile-bars__stack ${index === top ? "is-accent" : ""}`} style={{ height: `${(count / peak) * 100}%` }}>
                <i />
              </div>
              <span>{index + 1}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Genres({ data }: { data: Overview }) {
  const { t } = useT();
  const language = useSettings((state) => state.language);
  const names = useAsync(() => tmdb.genreNames(), [language], `genre-names:${language}`);
  const shown = data.genres.filter((genre) => names.data?.has(genre.id)).slice(0, genreLimit);
  if (shown.length < 3) return null;
  const peak = shown[0].seconds;
  return (
    <section className="profile-card">
      <div className="profile-card__head">
        <h2>{t("profile.genres.title")}</h2>
      </div>
      <ul className="profile-list">
        {shown.map((genre, index) => (
          <li key={genre.id}>
            <span>{capitalize(names.data?.get(genre.id) ?? "")}</span>
            <i className={index === 0 ? "is-accent" : ""} style={{ width: `${(genre.seconds / peak) * 100}%` }} />
            <b>{formatHoursShort(genre.seconds)}</b>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Habits({ data }: { data: Overview }) {
  const { t, tn } = useT();
  const habits = data.habits;
  const lines: string[] = [];
  if (habits) {
    const part = habits.parts.indexOf(Math.max(...habits.parts));
    const weekdays = habits.weekdays.slice(0, 5).reduce((sum, value) => sum + value, 0) / 5;
    const weekend = (habits.weekdays[5] + habits.weekdays[6]) / 2;
    lines.push(t(`profile.habits.part.${part}` as "profile.habits.part.0", { when: weekend > weekdays * 1.3 ? t("profile.habits.weekend") : t("profile.habits.weekdays") }));
  }
  if (data.recordDay) lines.push(t("profile.habits.record", { count: tn("common.episodes", data.recordDay.episodes), title: data.recordDay.name }));
  if (habits?.audio) {
    const total = habits.audio.dub + habits.audio.original;
    lines.push(
      t("profile.habits.audio", {
        dub: Math.round((habits.audio.dub / total) * 100),
        original: Math.round((habits.audio.original / total) * 100),
      }),
    );
  }
  if (habits && habits.voices.length > 0) lines.push(t("profile.habits.voice", { name: habits.voices[0].name }));
  if (habits && habits.intro >= 60) lines.push(t("profile.habits.intro", { time: formatSeconds(habits.intro) }));
  if (data.longestStreak > 1 && data.currentStreak > 1) lines.push(tn("profile.habits.current", data.currentStreak));
  return (
    <section className="profile-card">
      <div className="profile-card__head">
        <h2>{t("profile.habits.title")}</h2>
      </div>
      {lines.length === 0 ? (
        <p className="profile-card__empty">{t("profile.habits.few")}</p>
      ) : (
        <ul className="profile-lines">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Details({ data }: { data: Overview }) {
  const { t, tn, locale } = useT();
  const [open, setOpen] = useState(false);
  const decadePeak = Math.max(1, ...data.decades.map((item) => item.seconds));
  const languages = data.languages.slice(0, 6);
  const languagePeak = Math.max(1, ...languages.map((item) => item.seconds));
  const weekdays = data.habits?.weekdays ?? null;
  const weekdayPeak = Math.max(1, ...(weekdays ?? [0]));
  const weekdayName = (index: number) => new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(2024, 0, 1 + index));
  return (
    <section className="profile-details">
      <button className="profile-details__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {t("profile.details.toggle")}
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="profile-grid">
          {data.decades.length > 0 && (
            <section className="profile-card">
              <div className="profile-card__head">
                <h2>{t("profile.details.decades")}</h2>
              </div>
              <ul className="profile-list">
                {data.decades.map((item) => (
                  <li key={item.decade}>
                    <span>{t("profile.details.decade", { decade: item.decade })}</span>
                    <i style={{ width: `${(item.seconds / decadePeak) * 100}%` }} />
                    <b>{formatHoursShort(item.seconds)}</b>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {languages.length > 0 && (
            <section className="profile-card">
              <div className="profile-card__head">
                <h2>{t("profile.details.languages")}</h2>
              </div>
              <ul className="profile-list">
                {languages.map((item) => (
                  <li key={item.code}>
                    <span>{languageName(item.code)}</span>
                    <i style={{ width: `${(item.seconds / languagePeak) * 100}%` }} />
                    <b>{formatHoursShort(item.seconds)}</b>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {weekdays && (
            <section className="profile-card profile-chart">
              <div className="profile-card__head">
                <h2>{t("profile.details.weekdays")}</h2>
              </div>
              <div className="profile-bars profile-bars--short">
                {weekdays.map((value, index) => (
                  <div key={index} className="profile-bars__column" title={formatSeconds(value)}>
                    <div className="profile-bars__stack" style={{ height: `${(value / weekdayPeak) * 100}%` }}>
                      <i />
                    </div>
                    <span>{weekdayName(index)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className="profile-card">
            <div className="profile-card__head">
              <h2>{t("profile.details.more")}</h2>
            </div>
            <ul className="profile-lines">
              {data.droppedAfter !== null && <li>{tn("profile.details.dropped", Math.round(data.droppedAfter))}</li>}
              {data.rewatches > 0 && <li>{tn("profile.details.rewatches", data.rewatches)}</li>}
              {data.busiestMonth && <li>{t("profile.details.busiest", { month: formatMonth(data.busiestMonth, "long", true) })}</li>}
              {data.top[0] && <li>{t("profile.details.top", { title: data.top[0].name, time: formatSeconds(data.top[0].seconds) })}</li>}
            </ul>
          </section>
        </div>
      )}
    </section>
  );
}

function ProfileEmpty() {
  const { t } = useT();
  const navigate = useNavigate();
  return (
    <section className="profile-empty">
      <Clock size={34} />
      <h2>{t("profile.empty.title")}</h2>
      <p>{t("profile.empty.text")}</p>
      <div className="profile-empty__actions">
        <button className="button button--primary" onClick={() => navigate("/settings#settings-data")}>
          <FileUp size={16} />
          {t("profile.empty.import")}
        </button>
        <button className="button" onClick={() => navigate("/")}>
          {t("profile.empty.home")}
        </button>
      </div>
      <small>{t("profile.empty.sources")}</small>
    </section>
  );
}

function ProfileOverview({ ledger }: { ledger: Ledger }) {
  const { t } = useT();
  const [periodId, setPeriodId] = useState<PeriodId>("all");
  const [kind, setKind] = useState<Kind | null>(null);
  const now = useMemo(() => Date.now(), []);
  const period = useMemo(() => periodOf(periodId, now), [periodId, now]);
  const data = useMemo(() => overview(ledger, period, kind, now), [ledger, period, kind, now]);
  const whole = useMemo(() => (periodId === "all" && kind === null ? data : overview(ledger, allTime, null, now)), [ledger, data, periodId, kind, now]);

  if (whole.seconds === 0 && whole.movies === 0 && whole.episodes === 0 && whole.rating.count === 0) return <ProfileEmpty />;

  const date = new Date(now);
  const periods: { id: PeriodId; label: string }[] = [
    { id: "all", label: t("profile.period.all") },
    { id: "year", label: String(date.getFullYear()) },
    { id: "month", label: monthNameStandalone(dayKey(now).slice(0, 7)) },
  ];
  const nothing = data.seconds === 0 && data.movies === 0 && data.episodes === 0;

  return (
    <div className="profile-layout">
      <div className="profile-main">
        <div className="profile-toolbar">
          <div className="segmented" role="radiogroup" aria-label={t("profile.period.label")}>
            {periods.map((item) => (
              <button key={item.id} role="radio" aria-checked={periodId === item.id} className={periodId === item.id ? "is-active" : ""} onClick={() => setPeriodId(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
          {kind && (
            <button className="chip is-active" onClick={() => setKind(null)}>
              {t("profile.kind.only", { kind: t(kindLabels[kind]) })}
              <X size={13} />
            </button>
          )}
        </div>
        {nothing ? (
          <section className="profile-card profile-card__empty profile-period-empty">
            {t("profile.period.nothing")}
            <button className="button button--small" onClick={() => setPeriodId("all")}>
              {t("profile.period.all")}
            </button>
          </section>
        ) : (
          <>
            <TimeCard data={data} kind={kind} onKind={setKind} />
            <Counters data={data} period={periodId} />
            <Heatmap data={data} now={now} />
            <div className="profile-grid">
              <MonthChart data={data} />
              <Ratings data={data} />
              <Genres data={data} />
              <Habits data={data} />
            </div>
            <Details data={data} />
          </>
        )}
      </div>
      <aside className="profile-side">
        <WatchingCard ledger={ledger} kind={kind} />
        <TopCard data={data} />
        <RecentCard ledger={ledger} kind={kind} />
      </aside>
    </div>
  );
}

function SidePoster({ path }: { path: string | null }) {
  return <span className="side-item__poster">{path && <img src={imageUrl(path, "w185") ?? undefined} alt="" loading="lazy" draggable={false} />}</span>;
}

function titlePath(key: string): string {
  const [type, id] = key.split(":");
  return `/title/${type}/${id}`;
}

function WatchingCard({ ledger, kind }: { ledger: Ledger; kind: Kind | null }) {
  const { t, tn } = useT();
  const tracked = useLibrary((state) => state.tracked);
  const progress = useLibrary((state) => state.progress);
  const items = useMemo(() => {
    return Object.entries(tracked)
      .filter(([key, entry]) => entry.status === "watching" && (kind === null || kindOf(key, ledger.input.info) === kind))
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, sideLimit)
      .map(([key, entry]) => {
        if (key.startsWith("movie:")) {
          const unit = progress[key];
          const share = unit && unit.duration > 1 ? unit.position / unit.duration : 0;
          return { key, entry, share, note: share > 0 ? t("profile.side.percent", { value: Math.round(share * 100) }) : t("profile.kind.movie") };
        }
        const watched = watchedEpisodeCount(progress, entry.id);
        const total = entry.totalEpisodes ?? 0;
        return {
          key,
          entry,
          share: total > 0 ? Math.min(1, watched / total) : 0,
          note: total > 0 ? t("profile.side.episodeOf", { watched, total }) : tn("common.episodes", watched),
        };
      });
  }, [tracked, progress, kind, ledger, t, tn]);
  if (items.length === 0) return null;
  return (
    <section className="profile-card side-card">
      <div className="profile-card__head">
        <h2>{t("profile.side.watching")}</h2>
        <Link to="/library?status=watching">{t("profile.side.all")}</Link>
      </div>
      <ul className="side-list">
        {items.map(({ key, entry, share, note }) => (
          <li key={key}>
            <Link className="side-item" to={titlePath(key)}>
              <SidePoster path={entry.poster} />
              <span className="side-item__text">
                <b>{entry.title}</b>
                <small>{note}</small>
                {share > 0 && (
                  <span className="side-item__meter">
                    <i className="is-accent" style={{ width: `${share * 100}%` }} />
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TopCard({ data }: { data: Overview }) {
  const { t } = useT();
  const tracked = useLibrary((state) => state.tracked);
  const top = data.top.slice(0, sideLimit);
  if (top.length === 0) return null;
  const peak = top[0].seconds;
  return (
    <section className="profile-card side-card">
      <div className="profile-card__head">
        <h2>{t("profile.side.top")}</h2>
      </div>
      <ul className="side-list">
        {top.map((item) => (
          <li key={item.key}>
            <Link className="side-item" to={titlePath(item.key)}>
              <SidePoster path={tracked[item.key]?.poster ?? null} />
              <span className="side-item__text">
                <b>{item.name}</b>
                <small>{formatSeconds(item.seconds)}</small>
                <span className="side-item__meter">
                  <i className={`kind-${item.kind}`} style={{ width: `${(item.seconds / peak) * 100}%` }} />
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function shortDay(at: number, locale: string, t: ReturnType<typeof useT>["t"]): string {
  const day = dayKey(at);
  const today = new Date();
  if (day === dayKey(today.getTime())) return t("profile.side.today");
  if (day === dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime())) return t("profile.side.yesterday");
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(new Date(at)).replace(/\.$/, "");
}

function RecentCard({ ledger, kind }: { ledger: Ledger; kind: Kind | null }) {
  const { t, tn, locale } = useT();
  const tracked = useLibrary((state) => state.tracked);
  const items = useMemo(
    () =>
      buildHistory(ledger, { kind, finishedOnly: false, key: null })
        .filter((day) => day.day !== null)
        .flatMap((day) => day.items)
        .slice(0, sideLimit),
    [ledger, kind],
  );
  if (items.length === 0) return null;
  return (
    <section className="profile-card side-card">
      <div className="profile-card__head">
        <h2>{t("profile.side.recent")}</h2>
        <Link to="/profile/history">{t("profile.side.allHistory")}</Link>
      </div>
      <ul className="side-list">
        {items.map((item) => (
          <li key={item.id}>
            <Link className="side-item" to={titlePath(item.key)}>
              <SidePoster path={tracked[item.key]?.poster ?? null} />
              <span className="side-item__text">
                <b>{item.name}</b>
                <small>
                  {shortDay(item.at as number, locale, t)} · {noteOf(item, t, tn)}
                </small>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Profile() {
  const { t } = useT();
  const { tab } = useParams();
  const [params] = useSearchParams();
  const { ledger } = useLedger();
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    void fillRuntimes();
  }, []);

  const years = useMemo(() => (ledger ? recapYears(ledger, Date.now()) : []), [ledger]);
  const year = Number(params.get("y")) || years[0];

  return (
    <div className="page profile">
      <ProfileHeader ledger={ledger} onEdit={() => setEditing(true)} />
      <nav className="profile-tabs">
        <NavLink to="/profile" end>
          {t("profile.tab.overview")}
        </NavLink>
        <NavLink to="/profile/history">{t("profile.tab.history")}</NavLink>
        {years.length > 0 && <NavLink to={`/profile/year?y=${year}`}>{t("profile.tab.year", { year })}</NavLink>}
        <NavLink to="/profile/friends">{t("profile.tab.friends")}</NavLink>
      </nav>
      {tab === "friends" ? (
        <FriendsTab />
      ) : !ledger ? (
        <div className="profile-skeleton">
          <div className="profile-card" />
          <div className="profile-card" />
          <div className="profile-card" />
        </div>
      ) : tab === "history" ? (
        <ProfileHistory ledger={ledger} />
      ) : tab === "year" && years.length > 0 ? (
        <YearRecap ledger={ledger} year={years.includes(year) ? year : years[0]} years={years} />
      ) : (
        <ProfileOverview ledger={ledger} />
      )}
      {editing && <ProfileEdit ledger={ledger} onClose={() => setEditing(false)} />}
    </div>
  );
}
