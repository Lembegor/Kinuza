// Title page: details, sources for a movie, seasons and episodes for a series.

import { useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Check,
  CheckCheck,
  CircleCheck,
  Clapperboard,
  Eye,
  EyeOff,
  FolderOpen,
  Play,
  Plus,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { CatalogError, PosterRow, typeLabel } from "../components/Cards";
import { RatingStars, StatusMenu } from "../components/TrackControls";
import { backend, describeError, isDesktop } from "../lib/backend";
import { formatBytes, formatDate, formatRuntime, formatSpeed, plural } from "../lib/format";
import { qualityRank } from "../lib/parse";
import { imageUrl, tmdb, type Details, type Episode, type MediaType } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { isWatched, toTitleRef, unitKey, useLibrary, type Source, type TitleRef } from "../state/library";
import { fileProgress, useTorrents } from "../state/torrents";
import { useUi, type AddSourceTarget } from "../state/ui";

const specialsSeason = 0;

export function sortSources(sources: Source[]): Source[] {
  return [...sources].sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality) || b.size - a.size);
}

async function revealFile(source: Source): Promise<void> {
  try {
    const path = await backend.fileLocation(source.infoHash, source.fileIndex);
    if (!isDesktop) return;
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch (error) {
    useUi.getState().toast(describeError(error), "error");
  }
}

async function openTrailer(key: string): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${key}`;
  if (!isDesktop) {
    window.open(url, "_blank");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/** Download state of the file behind a source. */
function SourceStatus({ source }: { source: Source }) {
  const torrent = useTorrents((state) => state.byHash[source.infoHash]);
  if (!torrent) return <span className="source-status source-status--missing">нет в загрузках</span>;

  const progress = fileProgress(torrent, source.fileIndex);
  if (progress >= 1) {
    return (
      <span className="source-status source-status--done">
        <CircleCheck size={14} />
        скачано
      </span>
    );
  }
  const speed = torrent.state === "live" && torrent.downloadSpeed > 0 ? ` · ${formatSpeed(torrent.downloadSpeed)}` : "";
  const label = torrent.state === "paused" ? "пауза" : `${Math.floor(progress * 100)}%${speed}`;
  return (
    <span className="source-status">
      <span className="bar bar--inline">
        <i style={{ width: `${progress * 100}%` }} />
      </span>
      {label}
    </span>
  );
}

function QualityChip({ source, onRemove }: { source: Source; onRemove: () => void }) {
  const progress = useTorrents((state) => fileProgress(state.byHash[source.infoHash], source.fileIndex));
  return (
    <span className={`quality-chip ${progress >= 1 ? "is-ready" : ""}`} title={source.fileName}>
      {source.quality || "видео"}
      {progress < 1 && <small>{Math.floor(progress * 100)}%</small>}
      <button aria-label="Убрать источник" onClick={onRemove}>
        <X size={11} />
      </button>
    </span>
  );
}

function MovieSources({ title, target }: { title: TitleRef; target: AddSourceTarget }) {
  const key = unitKey("movie", title.id);
  const stored = useLibrary((state) => state.sources[key]);
  const sources = useMemo(() => sortSources(stored ?? []), [stored]);
  const removeSource = useLibrary((state) => state.removeSource);
  const { play, openAddSource } = useUi.getState();

  return (
    <section className="section">
      <div className="section__head">
        <h2>Источники</h2>
        <button className="button" onClick={() => openAddSource({ target })}>
          <Plus size={16} />
          Добавить торрент
        </button>
      </div>
      {sources.length === 0 ? (
        <div className="hint-card">
          <Clapperboard size={22} />
          <div>
            <strong>Источника пока нет</strong>
            <p>
              Добавьте magnet-ссылку или .torrent-файл — фильм начнёт скачиваться, а смотреть можно сразу, не дожидаясь
              конца загрузки. Ссылку можно просто вставить (Ctrl+V), а файл — перетащить в окно.
            </p>
          </div>
        </div>
      ) : (
        <div className="source-list">
          {sources.map((source) => (
            <div key={source.id} className="source-row">
              <button className="round-button" aria-label="Смотреть" onClick={() => play({ title, unitKey: key, preferredSourceId: source.id })}>
                <Play size={16} fill="currentColor" />
              </button>
              <div className="source-row__main">
                <div className="source-row__title">
                  <span className="quality-tag">{source.quality || "видео"}</span>
                  {source.tags.map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                  <span className="source-row__size">{formatBytes(source.size)}</span>
                </div>
                <div className="source-row__file">{source.fileName}</div>
              </div>
              <SourceStatus source={source} />
              <button className="icon-button" aria-label="Показать в папке" onClick={() => void revealFile(source)}>
                <FolderOpen size={16} />
              </button>
              <button className="icon-button" aria-label="Убрать источник" onClick={() => removeSource(key, source.id)}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EpisodeRow({ title, episode }: { title: TitleRef; episode: Episode }) {
  const key = unitKey("tv", title.id, episode.season, episode.episode);
  const stored = useLibrary((state) => state.sources[key]);
  const progress = useLibrary((state) => state.progress[key]);
  const { removeSource, setWatched } = useLibrary.getState();
  const play = useUi((state) => state.play);

  const sources = useMemo(() => sortSources(stored ?? []), [stored]);
  const watched = isWatched(progress);
  const playable = sources.length > 0;
  const still = imageUrl(episode.still, "w300");
  const watchedShare = progress && progress.duration > 0 ? Math.min(1, progress.position / progress.duration) : 0;

  const start = (preferredSourceId?: string) =>
    play({
      title,
      unitKey: key,
      season: episode.season,
      episode: episode.episode,
      episodeName: episode.name,
      preferredSourceId,
    });

  return (
    <div className={`episode ${playable ? "is-playable" : ""} ${watched ? "is-watched" : ""}`}>
      <button className="episode__still" disabled={!playable} onClick={() => start()} aria-label="Смотреть серию">
        {still ? <img src={still} alt="" loading="lazy" draggable={false} /> : <div className="episode__blank" />}
        {playable && (
          <span className="episode__play">
            <Play size={20} fill="currentColor" />
          </span>
        )}
        {watchedShare > 0 && !watched && (
          <div className="bar bar--thin">
            <i style={{ width: `${watchedShare * 100}%` }} />
          </div>
        )}
        {watched && (
          <span className="episode__seen">
            <Check size={13} />
          </span>
        )}
      </button>
      <div className="episode__body">
        <div className="episode__title">
          <span className="episode__number">{episode.episode}</span>
          {episode.name}
        </div>
        <div className="episode__meta">
          {[formatDate(episode.airDate), formatRuntime(episode.runtimeMinutes)].filter(Boolean).join(" · ")}
        </div>
        {episode.overview && <p className="episode__overview">{episode.overview}</p>}
      </div>
      <div className="episode__side">
        <div className="episode__chips">
          {sources.map((source) => (
            <QualityChip key={source.id} source={source} onRemove={() => removeSource(key, source.id)} />
          ))}
        </div>
        <button
          className="icon-button"
          aria-label={watched ? "Отметить непросмотренной" : "Отметить просмотренной"}
          title={watched ? "Отметить непросмотренной" : "Отметить просмотренной"}
          onClick={() =>
            setWatched(key, !watched, { title, season: episode.season, episode: episode.episode, episodeName: episode.name })
          }
        >
          {watched ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}

function SeriesEpisodes({
  details,
  title,
  season,
  onSeasonChange,
  target,
}: {
  details: Details;
  title: TitleRef;
  season: number;
  onSeasonChange: (season: number) => void;
  target: AddSourceTarget;
}) {
  const episodes = useAsync(() => tmdb.season(details.id, season), [details.id, season]);
  const sources = useLibrary((state) => state.sources);
  const progress = useLibrary((state) => state.progress);
  const openAddSource = useUi((state) => state.openAddSource);

  const keyOf = (episode: Episode) => unitKey("tv", details.id, episode.season, episode.episode);
  const list = episodes.data ?? [];
  const total = list.length;
  const available = list.filter((episode) => sources[keyOf(episode)]).length;
  const watched = list.filter((episode) => isWatched(progress[keyOf(episode)])).length;
  const seasonWatched = total > 0 && watched === total;

  const note = [
    `${total} ${plural(total, "серия", "серии", "серий")}`,
    available > 0 ? `добавлено ${available}` : "",
    watched > 0 ? `просмотрено ${watched}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const toggleSeasonWatched = () =>
    useLibrary.getState().setManyWatched(
      list.map((episode) => ({
        unitKey: keyOf(episode),
        context: { title, season: episode.season, episode: episode.episode, episodeName: episode.name },
      })),
      !seasonWatched,
    );

  return (
    <section className="section">
      <div className="section__head">
        <h2>Серии</h2>
        {total > 0 && <span className="section__note">{note}</span>}
        <div className="section__actions">
          {total > 0 && (
            <button className="button" onClick={toggleSeasonWatched}>
              <CheckCheck size={16} />
              {seasonWatched ? "Снять отметки" : "Сезон просмотрен"}
            </button>
          )}
          <button className="button" onClick={() => openAddSource({ target })}>
            <Plus size={16} />
            Добавить торрент
          </button>
        </div>
      </div>

      {details.seasons.length > 1 && (
        <div className="chips chips--scroll">
          {details.seasons.map((item) => (
            <button
              key={item.seasonNumber}
              className={`chip ${item.seasonNumber === season ? "is-active" : ""}`}
              onClick={() => onSeasonChange(item.seasonNumber)}
            >
              {item.seasonNumber === specialsSeason ? "Спецвыпуски" : `Сезон ${item.seasonNumber}`}
            </button>
          ))}
        </div>
      )}

      {episodes.error ? (
        <CatalogError onRetry={episodes.reload} />
      ) : episodes.loading ? (
        <div className="episode-list">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="episode episode--skeleton" />
          ))}
        </div>
      ) : (
        <div className="episode-list">
          {(episodes.data ?? []).map((episode) => (
            <EpisodeRow key={episode.episode} title={title} episode={episode} />
          ))}
        </div>
      )}
    </section>
  );
}

/** The episode to offer on the main button: the one in progress, else the first unwatched with a source. */
function useResumeEpisode(details: Details | null): { season: number; episode: number; name?: string; resumed: boolean } | null {
  const progress = useLibrary((state) => state.progress);
  const sources = useLibrary((state) => state.sources);
  return useMemo(() => {
    if (!details || details.type !== "tv") return null;
    const prefix = `tv:${details.id}:`;

    const inProgress = Object.entries(progress)
      .filter(([key, item]) => key.startsWith(prefix) && !isWatched(item) && sources[key])
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)[0];
    if (inProgress) {
      const [, item] = inProgress;
      return { season: item.season ?? 1, episode: item.episode ?? 1, name: item.episodeName, resumed: true };
    }

    const candidates = Object.keys(sources)
      .filter((key) => key.startsWith(prefix) && !isWatched(progress[key]))
      .map((key) => key.slice(prefix.length).split(":").map(Number))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const first = candidates.find(([seasonNumber]) => seasonNumber !== specialsSeason) ?? candidates[0];
    return first ? { season: first[0], episode: first[1], resumed: false } : null;
  }, [details, progress, sources]);
}

export default function TitlePage() {
  const params = useParams();
  const type = params.type as MediaType;
  const id = Number(params.id);
  const [searchParams, setSearchParams] = useSearchParams();

  const details = useAsync(() => tmdb.details(type, id), [type, id]);
  const data = details.data && details.data.id === id ? details.data : null;
  const title = useMemo(() => (data ? toTitleRef(data) : null), [data]);

  const movieSources = useLibrary((state) => state.sources[unitKey("movie", id)]);
  const resume = useResumeEpisode(data);
  const { play, openAddSource, setPageTarget } = useUi.getState();

  const firstSeason = data?.seasons.find((season) => season.seasonNumber !== specialsSeason)?.seasonNumber ?? data?.seasons[0]?.seasonNumber ?? 1;
  const requestedSeason = searchParams.get("s");
  const season = requestedSeason !== null ? Number(requestedSeason) : (resume?.season ?? firstSeason);

  const target = useMemo<AddSourceTarget | null>(
    () => (data && title ? { title, originalTitle: data.originalTitle, seasons: data.seasons, defaultSeason: season } : null),
    [data, title, season],
  );

  useEffect(() => {
    setPageTarget(target);
    return () => setPageTarget(null);
  }, [target, setPageTarget]);

  // A tracked series needs its episode count to know when it has been watched to the end.
  useEffect(() => {
    if (!data || !title) return;
    const regularEpisodes = data.seasons
      .filter((item) => item.seasonNumber !== specialsSeason)
      .reduce((sum, item) => sum + item.episodeCount, 0);
    useLibrary.getState().noteTitleDetails(title, data.type === "tv" ? regularEpisodes : undefined);
  }, [data, title]);

  if (details.error) {
    return (
      <div className="page">
        <CatalogError onRetry={details.reload} />
      </div>
    );
  }
  if (!data || !title || !target) return <div className="page page--flush"><div className="title-hero title-hero--skeleton" /></div>;

  const backdrop = imageUrl(data.backdrop, "w1280");
  const poster = imageUrl(data.poster, "w500");
  const bestMovieSource = type === "movie" && movieSources?.length ? sortSources(movieSources)[0] : null;

  const meta = [
    data.year,
    typeLabel(data),
    type === "movie" ? formatRuntime(data.runtimeMinutes) : data.seasons.length > 0 ? `${data.seasons.filter((s) => s.seasonNumber !== specialsSeason).length || 1} сез.` : "",
    data.countries.slice(0, 2).join(", "),
  ].filter(Boolean);

  const playResume = () => {
    if (bestMovieSource) {
      play({ title, unitKey: unitKey("movie", id) });
      return;
    }
    if (resume) {
      play({
        title,
        unitKey: unitKey("tv", id, resume.season, resume.episode),
        season: resume.season,
        episode: resume.episode,
        episodeName: resume.name,
      });
    }
  };
  const canPlay = Boolean(bestMovieSource || resume);
  const playLabel = resume ? `${resume.resumed ? "Продолжить" : "Смотреть"} · С${resume.season} Э${resume.episode}` : "Смотреть";

  return (
    <div className="page page--flush">
      <section className="title-hero">
        {backdrop && <img className="title-hero__backdrop" src={backdrop} alt="" draggable={false} />}
        <div className="title-hero__shade" />
        <div className="title-hero__body">
          <div className="title-hero__poster">{poster && <img src={poster} alt="" draggable={false} />}</div>
          <div className="title-hero__info">
            <h1>{data.title}</h1>
            {data.originalTitle && data.originalTitle !== data.title && <div className="title-hero__original">{data.originalTitle}</div>}
            <div className="title-hero__meta">
              {data.rating > 0 && (
                <span className="rating">
                  <Star size={13} fill="currentColor" />
                  {data.rating.toFixed(1)}
                </span>
              )}
              {meta.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
            {data.genres.length > 0 && (
              <div className="title-hero__genres">
                {data.genres.map((genre) => (
                  <span key={genre} className="tag">
                    {genre}
                  </span>
                ))}
              </div>
            )}
            {data.tagline && <div className="title-hero__tagline">{data.tagline}</div>}
            <p className="title-hero__overview">{data.overview || "Описание пока не добавлено."}</p>
            <div className="title-hero__actions">
              {canPlay ? (
                <button className="button button--primary button--large" onClick={playResume}>
                  <Play size={18} fill="currentColor" />
                  {playLabel}
                </button>
              ) : (
                <button className="button button--primary button--large" onClick={() => openAddSource({ target })}>
                  <Plus size={18} />
                  Добавить торрент
                </button>
              )}
              <StatusMenu title={title} />
              {data.trailerKey && (
                <button className="button button--large" onClick={() => void openTrailer(data.trailerKey!)}>
                  <Clapperboard size={18} />
                  Трейлер
                </button>
              )}
            </div>
            <RatingStars title={title} />
          </div>
        </div>
      </section>

      <div className="page__rows">
        {type === "movie" ? (
          <MovieSources title={title} target={target} />
        ) : (
          <SeriesEpisodes
            details={data}
            title={title}
            season={season}
            target={target}
            onSeasonChange={(next) => setSearchParams({ s: String(next) }, { replace: true })}
          />
        )}

        {data.cast.length > 0 && (
          <section className="section">
            <div className="section__head">
              <h2>В ролях</h2>
            </div>
            <div className="cast">
              {data.cast.map((person) => {
                const photo = imageUrl(person.photo, "w185");
                return (
                  <div key={person.id} className="cast__person">
                    <div className="cast__photo">{photo ? <img src={photo} alt="" loading="lazy" draggable={false} /> : person.name.slice(0, 1)}</div>
                    <strong>{person.name}</strong>
                    <span>{person.character}</span>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {data.recommendations.length > 0 && <PosterRow title="Похожее" items={data.recommendations} />}
      </div>
    </div>
  );
}
