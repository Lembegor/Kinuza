import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CalendarDays, Download, EllipsisVertical, EyeOff, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import { backend, describeError, isDesktop } from "../../lib/backend";
import { useT } from "../../lib/i18n";
import { buildHistory, episodeRanges, letterboxdCsv, type HistoryItem, type Kind, type Ledger } from "../../lib/profileStats";
import { formatDayLabel, formatSeconds, kindLabels, monthNameStandalone } from "../../lib/profileFormat";
import { imageUrl } from "../../lib/tmdb";
import { editActivity, type ActivityEvent } from "../../state/activity";
import { useLibrary } from "../../state/library";
import { useProfile } from "../../state/profile";
import { useUi } from "../../state/ui";

const pageDays = 30;

function episodesText(item: HistoryItem, t: ReturnType<typeof useT>["t"], tn: ReturnType<typeof useT>["tn"]): string {
  if (item.movie) return "";
  if (item.episodes.length === 0) return item.estimatedEpisodes > 0 ? tn("common.episodes", item.estimatedEpisodes) : "";
  const groups = episodeRanges(item.episodes);
  const many = groups.length > 1;
  return groups
    .map(({ season, ranges }) => {
      const list = ranges.map(([from, to]) => (from === to ? String(from) : `${from}-${to}`)).join(", ");
      const single = ranges.length === 1 && ranges[0][0] === ranges[0][1];
      const words = single ? t("profile.history.episode", { list }) : t("profile.history.episodes", { list });
      return many || season !== 1 ? t("profile.history.season", { season, list: words }) : words;
    })
    .join(" · ");
}

export function noteOf(item: HistoryItem, t: ReturnType<typeof useT>["t"], tn: ReturnType<typeof useT>["tn"]): string {
  const parts: string[] = [];
  if (item.movie) {
    if (item.finished) parts.push(item.rewatch ? t("profile.history.rewatch") : t("profile.history.movie"));
    else parts.push(t("profile.history.fragments"));
  } else {
    const episodes = episodesText(item, t, tn);
    parts.push(episodes || t("profile.history.watching"));
  }
  if (item.rating) parts.push(t("profile.history.rated", { value: item.rating }));
  return parts.join(" · ");
}

function ItemMenu({ item, events, onClose }: { item: HistoryItem; events: ActivityEvent[]; onClose: () => void }) {
  const { t } = useT();
  const [date, setDate] = useState(false);
  const [value, setValue] = useState(() => {
    const at = item.at ?? Date.now();
    const day = new Date(at);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
  });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const hide = () => {
    useProfile.getState().hideTitle(item.key);
    useUi.getState().toast(t("profile.history.hidden", { title: item.name }), "info", {
      label: t("feed.dismissed.undo"),
      run: () => useProfile.getState().showTitle(item.key),
    });
    onClose();
  };

  const remove = async () => {
    const removed = events.filter((event) => item.eventIds.includes(event.id));
    onClose();
    try {
      await editActivity(item.eventIds, []);
      useLibrary.getState().noteRemovedEvents(item.eventIds);
      useUi.getState().toast(t("profile.history.removed", { title: item.name }), "info", {
        label: t("feed.dismissed.undo"),
        run: () => {
          useLibrary.getState().forgetRemovedEvents(item.eventIds);
          void editActivity([], removed);
        },
      });
    } catch (error) {
      useUi.getState().toast(describeError(error), "error");
    }
  };

  const saveDate = async () => {
    const [y, m, d] = value.split("-").map(Number);
    if (!y || !m || !d) return;
    const seenAt = new Date(y, m - 1, d, 20).getTime();
    const marks = events.filter((event) => item.markIds.includes(event.id));
    onClose();
    try {
      await editActivity([], marks.map((event) => ({ ...event, earlier: false, seenAt })));
    } catch (error) {
      useUi.getState().toast(describeError(error), "error");
    }
  };

  const markToday = async () => {
    const marks = events.filter((event) => item.markIds.includes(event.id));
    onClose();
    await editActivity([], marks.map((event) => ({ ...event, earlier: false })));
  };

  return (
    <div className="profile-menu history-item__menu" ref={rootRef} role="menu">
      {date ? (
        <div className="history-item__date">
          <input
            className="input"
            type="date"
            value={value}
            max={new Date().toISOString().slice(0, 10)}
            aria-label={t("profile.history.date")}
            onChange={(event) => setValue(event.target.value)}
          />
          <button className="button button--primary button--small" onClick={() => void saveDate()}>
            {t("settings.save")}
          </button>
        </div>
      ) : (
        <>
          {item.markIds.length > 0 && (
            <button role="menuitem" onClick={() => setDate(true)}>
              <CalendarDays size={16} />
              {t("profile.history.date")}
            </button>
          )}
          {item.markIds.length > 0 && item.at === null && (
            <button role="menuitem" onClick={() => void markToday()}>
              <RotateCcw size={16} />
              {t("profile.earlier.today")}
            </button>
          )}
          <button role="menuitem" onClick={hide}>
            <EyeOff size={16} />
            {t("profile.history.hide")}
          </button>
          {item.eventIds.length > 0 && (
            <button role="menuitem" className="is-danger" onClick={() => void remove()}>
              <Trash2 size={16} />
              {t("profile.history.remove")}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function HistoryRow({ item, events }: { item: HistoryItem; events: ActivityEvent[] }) {
  const { t, tn } = useT();
  const poster = useLibrary((state) => state.tracked[item.key]?.poster ?? null);
  const [menu, setMenu] = useState(false);
  const [type, id] = item.key.split(":");
  return (
    <li className="history-item">
      <Link className="history-item__poster" to={`/title/${type}/${id}`} tabIndex={-1} aria-hidden="true">
        {poster && <img src={imageUrl(poster, "w185") ?? undefined} alt="" loading="lazy" draggable={false} />}
      </Link>
      <div className="history-item__text">
        <Link to={`/title/${type}/${id}`}>{item.name || t("profile.history.unknown")}</Link>
        <span>{noteOf(item, t, tn)}</span>
      </div>
      <span className="history-item__time" title={item.estimated ? t("profile.time.estimateHint") : undefined}>
        {item.seconds > 0 ? `${item.estimated ? "≈ " : ""}${formatSeconds(item.seconds)}` : ""}
      </span>
      <div className="history-item__tools">
        <button className="icon-button" aria-label={t("profile.history.actions", { title: item.name })} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((value) => !value)}>
          <EllipsisVertical size={16} />
        </button>
        {menu && <ItemMenu item={item} events={events} onClose={() => setMenu(false)} />}
      </div>
    </li>
  );
}

export function ProfileHistory({ ledger }: { ledger: Ledger }) {
  const { t, tn } = useT();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [kind, setKind] = useState<Kind | null>(null);
  const [finishedOnly, setFinishedOnly] = useState(false);
  const [shown, setShown] = useState(pageDays);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const paused = useProfile((state) => state.historyPaused);
  const tracked = useLibrary((state) => state.tracked);
  const titleFilter = params.get("title");
  const dayFilter = params.get("day");

  const days = useMemo(() => {
    const list = buildHistory(ledger, { kind, finishedOnly, key: titleFilter });
    return dayFilter ? list.filter((day) => day.day === dayFilter) : list;
  }, [ledger, kind, finishedOnly, titleFilter, dayFilter]);

  const dated = days.filter((day) => day.day !== null);
  const earlier = days.find((day) => day.day === null);
  const filteredTitle = titleFilter ? (tracked[titleFilter]?.title ?? ledger.entries.find((entry) => entry.key === titleFilter)?.name ?? "") : null;

  const clearFilter = (name: "title" | "day") => {
    const next = new URLSearchParams(params);
    next.delete(name);
    setParams(next, { replace: true });
  };

  const exportCsv = async () => {
    const ratings = Object.fromEntries(Object.entries(tracked).map(([key, entry]) => [key, entry.rating]));
    const text = letterboxdCsv(ledger, ratings);
    const day = new Date().toISOString().slice(0, 10);
    const name = `${t("profile.history.exportName")} ${day}.csv`;
    try {
      if (isDesktop) {
        const path = await backend.pickSaveTarget({ title: t("profile.history.export"), defaultName: name, filterName: "CSV", extensions: ["csv"] });
        if (!path) return;
        await backend.writeTextFile(path, text);
      } else {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
        link.download = name;
        link.click();
        URL.revokeObjectURL(link.href);
      }
      useUi.getState().toast(t("profile.history.exported"), "success");
    } catch (error) {
      useUi.getState().toast(describeError(error), "error");
    }
  };

  const kindsList: (Kind | null)[] = [null, "movie", "tv", "anime"];

  const months = useMemo(() => {
    const list: { month: string; seconds: number; days: number; first: number }[] = [];
    dated.forEach((day, index) => {
      const month = (day.day as string).slice(0, 7);
      const last = list[list.length - 1];
      if (last && last.month === month) {
        last.seconds += day.seconds;
        last.days += 1;
      } else list.push({ month, seconds: day.seconds, days: 1, first: index });
    });
    return list;
  }, [dated]);
  const totalSeconds = days.reduce((sum, day) => sum + day.seconds, 0);

  const jump = (first: number) => {
    setShown((value) => Math.max(value, first + pageDays));
    const day = dated[first]?.day;
    setTimeout(() => document.getElementById(`history-day-${day}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  return (
    <div className="profile-layout profile-history">
      <div className="profile-main">
        <div className="profile-toolbar">
          <div className="chips">
            {kindsList.map((item) => (
              <button key={item ?? "all"} className={`chip ${kind === item ? "is-active" : ""}`} onClick={() => setKind(item)}>
                {item ? t(kindLabels[item]) : t("library.filter.all")}
              </button>
            ))}
            <button className={`chip ${finishedOnly ? "is-active" : ""}`} aria-pressed={finishedOnly} onClick={() => setFinishedOnly((value) => !value)}>
              {t("profile.history.finishedOnly")}
            </button>
            {filteredTitle !== null && (
              <button className="chip is-active" onClick={() => clearFilter("title")}>
                {t("profile.history.onlyTitle", { title: filteredTitle })}
                <X size={13} />
              </button>
            )}
            {dayFilter && (
              <button className="chip is-active" onClick={() => clearFilter("day")}>
                {formatDayLabel(dayFilter)}
                <X size={13} />
              </button>
            )}
          </div>
          <div className="profile-toolbar__end">
            <button
              className={`button button--small ${paused ? "is-warning" : ""}`}
              aria-pressed={paused}
              title={t("profile.paused.hint")}
              onClick={() => useProfile.getState().patch({ historyPaused: !paused })}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
              {paused ? t("profile.paused.resume") : t("profile.paused.pause")}
            </button>
            <button className="button button--small" title={t("profile.history.exportHint")} onClick={() => void exportCsv()}>
              <Download size={14} />
              {t("profile.history.export")}
            </button>
          </div>
        </div>
        {paused && <p className="profile-note">{t("profile.paused.note")}</p>}
        {days.length === 0 ? (
          <section className="profile-card profile-card__empty">{t("profile.history.empty")}</section>
        ) : (
          <>
            {dated.slice(0, shown).map((day) => (
              <section key={day.day} id={`history-day-${day.day}`} className="history-day">
                <div className="history-day__head">
                  <h2>{formatDayLabel(day.day as string)}</h2>
                  <span>
                    {day.approximate && <em title={t("profile.history.approximateHint")}>{t("profile.history.approximate")}</em>}
                    {day.seconds > 0 && formatSeconds(day.seconds)}
                  </span>
                </div>
                <ul>
                  {day.items.map((item) => (
                    <HistoryRow key={item.id} item={item} events={ledger.input.events} />
                  ))}
                </ul>
              </section>
            ))}
            {dated.length > shown && (
              <button className="button profile-more" onClick={() => setShown((value) => value + pageDays)}>
                {t("profile.history.more")}
              </button>
            )}
            {earlier && (
              <section className="history-day history-day--earlier">
                <button className="history-day__head history-day__toggle" aria-expanded={earlierOpen} onClick={() => setEarlierOpen((value) => !value)}>
                  <h2>{t("profile.history.earlier")}</h2>
                  <span>
                    {tn("profile.history.earlierCount", earlier.items.length)}
                    {earlier.seconds > 0 && ` · ≈ ${formatSeconds(earlier.seconds)}`}
                  </span>
                </button>
                <p className="profile-note">{t("profile.history.earlierNote")}</p>
                {earlierOpen && (
                  <ul>
                    {earlier.items.map((item) => (
                      <HistoryRow key={item.id} item={item} events={ledger.input.events} />
                    ))}
                  </ul>
                )}
              </section>
            )}
          </>
        )}
        <p className="profile-note profile-note--end">
          {t("profile.history.settingsNote")}{" "}
          <button className="link-button" onClick={() => navigate("/settings#settings-history")}>
            {t("profile.history.settingsLink")}
          </button>
        </p>
      </div>
      {months.length > 1 && (
        <aside className="profile-side">
          <section className="profile-card side-card">
            <div className="profile-card__head">
              <h2>{t("profile.history.months")}</h2>
            </div>
            <ul className="side-months">
              {months.map((item) => (
                <li key={item.month}>
                  <button onClick={() => jump(item.first)}>
                    <span>
                      {monthNameStandalone(item.month)} {item.month.slice(0, 4) !== String(new Date().getFullYear()) ? item.month.slice(0, 4) : ""}
                    </span>
                    <b>{formatSeconds(item.seconds)}</b>
                  </button>
                </li>
              ))}
            </ul>
            {totalSeconds > 0 && <p className="side-card__foot">{t("profile.history.total", { time: formatSeconds(totalSeconds) })}</p>}
          </section>
        </aside>
      )}
    </div>
  );
}
