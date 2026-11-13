import { useEffect, useRef, useState } from "react";
import { Check, Search, X } from "lucide-react";
import { useT } from "../lib/i18n";
import { imageUrl, tmdb, type Episode, type SeasonInfo } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { isWatched, unitKey, useLibrary } from "../state/library";
import { useSettings } from "../state/settings";
import { arcsOfSeason, type EpisodeLayout } from "../lib/episodeLayout";

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function PlayerEpisodes({
  titleId,
  seasons,
  layout,
  current,
  onPlay,
  onFind,
  onClose,
}: {
  titleId: number;
  seasons: SeasonInfo[];
  layout: EpisodeLayout | null;
  current: { season: number; episode: number };
  onPlay: (episode: Episode) => void;
  onFind: (episode: Episode) => void;
  onClose: () => void;
}) {
  const { t, locale } = useT();
  const seasonLabel = (item: SeasonInfo) => {
    const arcs = layout ? arcsOfSeason(layout, item.seasonNumber) : [];
    if (arcs.length === 0) return t("common.season", { season: item.seasonNumber });
    const range = `${arcs[0].first}-${arcs[arcs.length - 1].last}`;
    return item.name ? `${item.name} · ${range}` : range;
  };
  const shown = seasons.filter((season) => season.episodeCount > 0).sort((a, b) => (a.seasonNumber || Infinity) - (b.seasonNumber || Infinity));
  const [season, setSeason] = useState(current.season);
  const episodes = useAsync(() => tmdb.season(titleId, season), [titleId, season]);
  const sources = useLibrary((state) => state.sources);
  const progress = useLibrary((state) => state.progress);
  const hideStills = useSettings((state) => state.spoilerStills);
  const listRef = useRef<HTMLDivElement>(null);
  const day = today();

  useEffect(() => {
    if (season !== current.season || !episodes.data) return;
    listRef.current?.querySelector(".player__episode.is-current")?.scrollIntoView({ block: "center" });
  }, [episodes.data, season, current.season]);

  return (
    <aside className="player__episodes" role="dialog" aria-label={t("player.episodes")} onClick={(event) => event.stopPropagation()}>
      <div className="player__episodes-head">
        <strong>{t("player.episodes")}</strong>
        <button className="icon-button" aria-label={t("common.close")} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {shown.length > 1 && (
        <div className="player__episodes-seasons" role="tablist">
          {shown.map((item) => (
            <button
              key={item.seasonNumber}
              role="tab"
              aria-selected={item.seasonNumber === season}
              className={`chip ${item.seasonNumber === season ? "is-active" : ""}`}
              onClick={() => setSeason(item.seasonNumber)}
            >
              {item.seasonNumber === 0 ? t("common.specials") : seasonLabel(item)}
            </button>
          ))}
        </div>
      )}
      <div className="player__episodes-list" ref={listRef}>
        {episodes.loading && <p className="player__episodes-note">{t("player.episodes.loading")}</p>}
        {(episodes.data ?? []).map((episode) => {
          const key = unitKey("tv", titleId, episode.season, episode.episode);
          const available = (sources[key] ?? []).length > 0;
          const saved = progress[key];
          const watched = isWatched(saved);
          const share = saved && saved.duration > 0 ? Math.min(1, saved.position / saved.duration) : 0;
          const isCurrent = episode.season === current.season && episode.episode === current.episode;
          const aired = episode.airDate === "" || episode.airDate <= day;
          const still = episode.still && (!hideStills || watched) ? imageUrl(episode.still, "w300") : null;
          const meta = [
            episode.runtimeMinutes ? t("player.episodes.minutes", { minutes: episode.runtimeMinutes }) : "",
            episode.airDate ? new Date(episode.airDate).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }) : "",
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <div
              key={key}
              className={`player__episode ${isCurrent ? "is-current" : ""} ${available ? "is-available" : ""}`}
              role="button"
              tabIndex={available && !isCurrent ? 0 : -1}
              aria-disabled={!available || isCurrent}
              onClick={() => available && !isCurrent && onPlay(episode)}
              onKeyDown={(event) => {
                if ((event.key === "Enter" || event.key === " ") && available && !isCurrent) {
                  event.preventDefault();
                  onPlay(episode);
                }
              }}
            >
              <div className="player__episode-still">
                {still ? <img src={still} alt="" loading="lazy" draggable={false} /> : <span>{episode.episode}</span>}
                {share > 0 && !watched && <i style={{ width: `${share * 100}%` }} />}
              </div>
              <div className="player__episode-body">
                <strong>
                  {episode.episode}. {episode.name}
                </strong>
                <span>{meta}</span>
                {isCurrent ? (
                  <em className="player__episode-tag player__episode-tag--now">{t("player.episodes.now")}</em>
                ) : !aired ? (
                  <em className="player__episode-tag">{t("player.episodes.notAired")}</em>
                ) : !available ? (
                  <button
                    className="player__episode-find"
                    onClick={(event) => {
                      event.stopPropagation();
                      onFind(episode);
                    }}
                  >
                    <Search size={13} />
                    {t("player.episodes.find")}
                  </button>
                ) : null}
              </div>
              {watched && !isCurrent && (
                <span className="player__episode-watched" title={t("player.episodes.watched")}>
                  <Check size={14} />
                </span>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
