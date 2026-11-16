import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Info, Play, X } from "lucide-react";
import { Row, useDismissOutside } from "../Cards";
import { t, tn, useT } from "../../lib/i18n";
import { imageUrl, tmdb } from "../../lib/tmdb";
import { useAsync } from "../../lib/useAsync";
import { localDay } from "../../state/calendar";
import { daysSince, hideFromContinue, useIsDownloaded, type ContinueItem } from "../../state/continueItems";
import { titleKey, useLibrary } from "../../state/library";
import { useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import { useHoverWarm } from "../../state/warmup";

const secondsPerMinute = 60;
const minutesPerHour = 60;

function remainingLabel(position: number, duration: number): string {
  const minutes = Math.max(1, Math.round((duration - position) / secondsPerMinute));
  const hours = Math.floor(minutes / minutesPerHour);
  const time = hours > 0 ? t("common.duration.hoursMinutes", { hours, minutes: minutes % minutesPerHour }) : t("common.duration.minutes", { minutes });
  return t("home.continue.remaining", { time });
}

function airedLabel(airDate: string): string {
  const days = daysSince(airDate, localDay(new Date()));
  if (days <= 0) return t("home.continue.airedToday");
  if (days === 1) return t("home.continue.airedYesterday");
  return tn("home.continue.airedDaysAgo", days);
}

function episodeLabel(item: ContinueItem): string {
  if (item.title.type !== "tv" || item.season === undefined) return t("common.type.movie");
  return t("common.seasonEpisode", { season: item.season, episode: item.episode ?? "" });
}

function ContinueCard({ item, offline }: { item: ContinueItem; offline: boolean }) {
  const { t } = useT();
  const navigate = useNavigate();
  const play = useUi((state) => state.play);
  const hasSource = useLibrary((state) => (state.sources[item.unitKey]?.length ?? 0) > 0);
  const downloaded = useIsDownloaded(item.unitKey);
  const hideStill = useSettings((state) => state.spoilerStills);
  const hoverWarm = useHoverWarm(hasSource && !offline ? item.unitKey : null);
  const [asking, setAsking] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setAsking(false), []);
  useDismissOutside(asking, menuRef, closeMenu);
  const { title } = item;
  const unavailable = offline && !downloaded;

  const seasonNumber = item.kind === "resume" && title.type === "tv" ? item.season : undefined;
  const season = useAsync(
    () => (seasonNumber !== undefined && !offline ? tmdb.season(title.id, seasonNumber) : Promise.resolve([])),
    [title.id, seasonNumber, offline],
    `continue-season:${title.id}:${seasonNumber ?? "-"}`,
  );
  const stills = (season.data ?? []).filter((episode) => episode.still);
  const ownStill = item.kind === "resume" ? stills.find((episode) => episode.episode === item.episode)?.still : item.still;
  const still = hideStill ? null : (ownStill ?? null);
  const art = imageUrl(still, "w500") ?? imageUrl(title.backdrop, "w780") ?? imageUrl(stills[0]?.still ?? null, "w500") ?? imageUrl(title.poster, "w342");

  const openTitle = () => navigate(title.type === "tv" && item.season !== undefined ? `/title/tv/${title.id}?s=${item.season}` : `/title/${title.type}/${title.id}`);
  const start = () => {
    if (!hasSource || unavailable) {
      openTitle();
      return;
    }
    play({ title, unitKey: item.unitKey, season: item.season, episode: item.episode, episodeName: item.episodeName });
  };
  const context = { title, season: item.season, episode: item.episode, episodeName: item.episodeName };

  const markWatched = () => {
    const library = useLibrary.getState();
    const before = library.progress[item.unitKey];
    library.setWatched(item.unitKey, true, context);
    useUi.getState().toast(t("home.continue.markedWatched", { title: title.title }), "success", {
      label: t("feed.dismissed.undo"),
      run: () => (before ? useLibrary.getState().restoreProgress(item.unitKey, before) : useLibrary.getState().setWatched(item.unitKey, false, context)),
    });
  };
  const hide = () => {
    setAsking(false);
    const undo = hideFromContinue(title);
    useUi.getState().toast(t("home.continue.hidden", { title: title.title }), "info", { label: t("feed.dismissed.undo"), run: undo });
  };
  const drop = () => {
    setAsking(false);
    const library = useLibrary.getState();
    const entry = library.tracked[titleKey(title.type, title.id)];
    library.setStatus(title, "dropped");
    useUi.getState().toast(t("home.continue.dropped", { title: title.title }), "info", {
      label: t("feed.dismissed.undo"),
      run: () => {
        if (entry) useLibrary.getState().restoreTracked(titleKey(title.type, title.id), entry);
        else useLibrary.getState().removeTracked(titleKey(title.type, title.id));
      },
    });
  };

  const tag =
    item.kind === "new"
      ? { text: t("home.continue.tag.new"), tone: "red" }
      : item.kind === "next"
        ? { text: t("home.continue.tag.next"), tone: "grey" }
        : downloaded
          ? { text: t("home.continue.tag.downloaded"), tone: "green" }
          : null;
  const detail = unavailable
    ? t("home.continue.needsNetwork")
    : item.kind === "resume" && item.progress && item.progress.duration > secondsPerMinute
      ? remainingLabel(item.progress.position, item.progress.duration)
      : item.kind === "new" && item.airDate
        ? airedLabel(item.airDate)
        : item.kind !== "resume" && !hasSource
          ? t("home.upNext.noSource")
          : (item.episodeName ?? "");
  const playLabel = hasSource && !unavailable ? t("home.continue.resume", { title: title.title }) : t("home.upNext.find", { title: title.title });

  return (
    <div className={`continue-card ${unavailable ? "is-unavailable" : ""}`}>
      <button className="continue-card__art" {...hoverWarm} aria-label={playLabel} onClick={start}>
        {art && <img src={art} alt="" loading="lazy" draggable={false} />}
        {tag && <span className={`continue-card__tag is-${tag.tone}`}>{tag.text}</span>}
        <span className="continue-card__play">
          <Play size={22} fill="currentColor" />
        </span>
        {item.progress && item.progress.duration > 0 && (
          <div className="bar bar--thin">
            <i style={{ width: `${(item.progress.position / item.progress.duration) * 100}%` }} />
          </div>
        )}
      </button>
      <div className="continue-card__tools" ref={menuRef}>
        <button className="continue-card__info" aria-label={t("home.continue.markWatched")} title={t("home.continue.markWatched")} onClick={markWatched}>
          <Check size={16} />
        </button>
        <button className="continue-card__info" aria-label={t("home.continue.page", { title: title.title })} title={t("common.openPage")} onClick={openTitle}>
          <Info size={16} />
        </button>
        <button
          className="continue-card__info"
          aria-label={t("home.continue.hide")}
          title={t("home.continue.hide")}
          aria-expanded={title.type === "tv" ? asking : undefined}
          onClick={() => (title.type === "tv" ? setAsking((value) => !value) : hide())}
        >
          <X size={16} />
        </button>
        {asking && (
          <div className="dismiss-menu continue-card__menu" role="menu">
            <button role="menuitem" onClick={hide}>
              {t("home.continue.hideOnce")}
            </button>
            <button role="menuitem" onClick={drop}>
              {t("home.continue.drop")}
            </button>
          </div>
        )}
      </div>
      <button className="continue-card__text" onClick={openTitle}>
        <div className="poster-card__title">{title.title}</div>
        <div className="poster-card__meta">
          <span>{episodeLabel(item)}</span>
          {detail && <span>{detail}</span>}
        </div>
      </button>
    </div>
  );
}

export function ContinueRow({ items, offline, menu }: { items: ContinueItem[]; offline: boolean; menu?: React.ReactNode }) {
  const { t } = useT();
  const navigate = useNavigate();
  if (items.length === 0) return null;
  return (
    <Row title={t("home.row.continue")} more={{ label: t("home.continue.history"), onClick: () => navigate("/profile/history") }} menu={menu}>
      {items.map((item) => (
        <ContinueCard key={item.unitKey} item={item} offline={offline} />
      ))}
    </Row>
  );
}
