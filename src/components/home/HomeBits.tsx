import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { CalendarDays, CircleCheck, CloudOff, Heart, Play, RotateCw, Settings2, SlidersHorizontal } from "lucide-react";
import { Row } from "../Cards";
import { useT } from "../../lib/i18n";
import { imageUrl, type MediaItem } from "../../lib/tmdb";
import { entryToRef, isWatched, titleKey, useLibrary, type TitleRef } from "../../state/library";
import { fileProgress, useTorrents } from "../../state/torrents";
import { useUi } from "../../state/ui";

const doneShare = 0.999;
const collageSize = 18;

export function HomeStarter({ posters }: { posters: MediaItem[] }) {
  const { t } = useT();
  const shown = posters.filter((item) => item.poster).slice(0, collageSize);
  return (
    <section className="home-starter">
      <div className="home-starter__collage" aria-hidden="true">
        {shown.map((item) => (
          <img key={`${item.type}:${item.id}`} src={imageUrl(item.poster, "w185") ?? undefined} alt="" draggable={false} />
        ))}
      </div>
      <div className="home-starter__shade" />
      <div className="home-starter__body">
        <span className="home-pick__pill is-soft">{t("home.starter.kicker")}</span>
        <h1>{t("home.starter.title")}</h1>
        <p>{t("home.starter.text")}</p>
        <div className="home-pick__actions">
          <button className="button button--primary button--large" onClick={() => useLibrary.setState({ firstRun: true })}>
            <Heart size={18} />
            {t("home.starter.pick")}
          </button>
        </div>
        <p className="home-starter__note">
          <CircleCheck size={15} />
          {t("home.starter.note")}
        </p>
      </div>
    </section>
  );
}

export function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  const { t } = useT();
  return (
    <div className="home-offline" role="status">
      <CloudOff size={18} />
      <span>{t("home.offline.text")}</span>
      <button className="button button--small" onClick={onRetry}>
        <RotateCw size={14} />
        {t("common.retry")}
      </button>
    </div>
  );
}

interface DownloadedTitle {
  title: TitleRef;
  units: string[];
}

function unitTitle(unitKey: string, state: ReturnType<typeof useLibrary.getState>): TitleRef | null {
  const progress = state.progress[unitKey];
  if (progress) return progress.title;
  const [type, id] = unitKey.split(":");
  const entry = state.tracked[`${type}:${id}`];
  return entry ? entryToRef(entry) : null;
}

export function DownloadedRow({ skip }: { skip: Set<string> }) {
  const { t, tn } = useT();
  const navigate = useNavigate();
  const play = useUi((state) => state.play);
  const sources = useLibrary((state) => state.sources);
  const progress = useLibrary((state) => state.progress);
  const tracked = useLibrary((state) => state.tracked);
  const byHash = useTorrents((state) => state.byHash);
  const titles = useMemo(() => {
    const state = useLibrary.getState();
    const grouped = new Map<string, DownloadedTitle>();
    for (const [unitKey, list] of Object.entries(sources)) {
      if (isWatched(progress[unitKey])) continue;
      if (!list.some((source) => fileProgress(byHash[source.infoHash], source.fileIndex) >= doneShare)) continue;
      const title = unitTitle(unitKey, state);
      if (!title) continue;
      const show = titleKey(title.type, title.id);
      if (skip.has(show)) continue;
      const known = grouped.get(show) ?? { title, units: [] };
      known.units.push(unitKey);
      grouped.set(show, known);
    }
    return [...grouped.values()];
  }, [sources, progress, tracked, byHash, skip]);
  if (titles.length === 0) return null;
  return (
    <Row title={t("home.row.downloaded")} aside={<span className="row__sub">{t("home.downloaded.sub")}</span>} more={{ label: t("shell.nav.downloads"), onClick: () => navigate("/downloads") }}>
      {titles.map(({ title, units }) => {
        const art = imageUrl(title.backdrop, "w780") ?? imageUrl(title.poster, "w342");
        const first = [...units].sort()[0];
        const [, , season, episode] = first.split(":").map(Number);
        const start = () =>
          title.type === "movie" ? play({ title, unitKey: first }) : play({ title, unitKey: first, season: season || undefined, episode: episode || undefined });
        return (
          <div key={titleKey(title.type, title.id)} className="continue-card">
            <button className="continue-card__art" aria-label={t("home.continue.resume", { title: title.title })} onClick={start}>
              {art && <img src={art} alt="" loading="lazy" draggable={false} />}
              <span className="continue-card__tag is-green">{t("home.continue.tag.downloaded")}</span>
              <span className="continue-card__play">
                <Play size={22} fill="currentColor" />
              </span>
            </button>
            <button className="continue-card__text" onClick={() => navigate(`/title/${title.type}/${title.id}`)}>
              <div className="poster-card__title">{title.title}</div>
              <div className="poster-card__meta">
                <span>{title.type === "movie" ? t("common.type.movie") : tn("common.episodes", units.length)}</span>
              </div>
            </button>
          </div>
        );
      })}
    </Row>
  );
}

export function HomeEnd({ onCustomize }: { onCustomize: () => void }) {
  const { t } = useT();
  const navigate = useNavigate();
  return (
    <nav className="home-end" aria-label={t("home.end.label")}>
      <button onClick={() => navigate("/browse")}>
        <SlidersHorizontal size={15} />
        {t("home.end.catalog")}
      </button>
      <button onClick={() => navigate("/calendar")}>
        <CalendarDays size={15} />
        {t("home.end.calendar")}
      </button>
      <button onClick={onCustomize}>
        <Settings2 size={15} />
        {t("home.end.customize")}
      </button>
    </nav>
  );
}
