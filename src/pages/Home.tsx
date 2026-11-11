import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Info, Play, Star } from "lucide-react";
import { CatalogError, PosterRow, Row, typeLabel } from "../components/Cards";
import { t, useT } from "../lib/i18n";
import { imageUrl, tmdb, type MediaItem } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { isNewEpisode, useEpisodeCalendar, type CalendarEpisode } from "../state/calendar";
import { usePersonalFeed } from "../state/feed";
import { entryToRef, isWatched, titleKey, useLibrary, type Progress, type TitleRef } from "../state/library";
import { useUi } from "../state/ui";
import { useUpNext, type UpNextEpisode } from "../state/upNext";

const heroRotationMs = 10000;
const heroItemCount = 6;
const minResumeSeconds = 30;
const continueRowLimit = 12;
const secondsPerMinute = 60;
const minutesPerHour = 60;

function slideKey(slide: MediaItem): string {
  return titleKey(slide.type, slide.id);
}

function Hero({ items }: { items: MediaItem[] }) {
  const { t } = useT();
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const slides = useMemo(() => items.filter((item) => item.backdrop && item.overview).slice(0, heroItemCount), [items]);

  useEffect(() => {
    if (slides.length < 2 || paused) return;
    const timer = setTimeout(() => setIndex((value) => (value + 1) % slides.length), heroRotationMs);
    return () => clearTimeout(timer);
  }, [slides.length, index, paused]);

  const current = slides[index];
  if (!current) return <div className="hero hero--skeleton" />;

  const step = (direction: 1 | -1) => setIndex((value) => (value + direction + slides.length) % slides.length);
  const open = () => navigate(`/title/${current.type}/${current.id}`);

  return (
    <section className="hero" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <img key={`ambient:${slideKey(current)}`} className="hero__ambient" src={imageUrl(current.backdrop, "w780") ?? undefined} alt="" draggable={false} />
      {slides.map((slide, slideIndex) => (
        <img
          key={slideKey(slide)}
          className={`hero__backdrop ${slideIndex === index ? "is-active" : ""}`}
          src={imageUrl(slide.backdrop, "w1280") ?? undefined}
          alt=""
          draggable={false}
        />
      ))}
      <div className="hero__shade" />
      <button className="hero__open" aria-label={t("home.hero.open", { title: current.title })} onClick={open} />
      <div className="hero__body" key={`body:${slideKey(current)}`}>
        <div className="hero__kicker">
          <span>{t("home.hero.trending")}</span>
          <span>{typeLabel(current)}</span>
          {current.year && <span>{current.year}</span>}
          {current.rating > 0 && (
            <span className="rating">
              <Star size={12} fill="currentColor" />
              {current.rating.toFixed(1)}
            </span>
          )}
        </div>
        <h1>
          <button onClick={open}>{current.title}</button>
        </h1>
        <p>{current.overview}</p>
        <div className="hero__actions">
          <button className="button button--primary button--large" onClick={open}>
            <Info size={18} />
            {t("home.hero.details")}
          </button>
        </div>
      </div>
      {slides.length > 1 && (
        <div className="hero__nav">
          <button className="hero__arrow" aria-label={t("home.hero.previous")} onClick={() => step(-1)}>
            <ChevronLeft size={20} />
          </button>
          <div className="hero__dots">
            {slides.map((slide, slideIndex) => (
              <button
                key={slideKey(slide)}
                aria-label={slide.title}
                className={slideIndex === index ? "is-active" : ""}
                onClick={() => setIndex(slideIndex)}
              />
            ))}
          </div>
          <button className="hero__arrow" aria-label={t("home.hero.next")} onClick={() => step(1)}>
            <ChevronRight size={20} />
          </button>
        </div>
      )}
    </section>
  );
}

function remainingLabel(progress: Progress): string {
  const minutes = Math.max(1, Math.round((progress.duration - progress.position) / secondsPerMinute));
  const hours = Math.floor(minutes / minutesPerHour);
  const time =
    hours > 0
      ? t("common.duration.hoursMinutes", { hours, minutes: minutes % minutesPerHour })
      : t("common.duration.minutes", { minutes });
  return t("home.continue.remaining", { time });
}

function ContinueCard({ unitKey, progress }: { unitKey: string; progress: Progress }) {
  const { t } = useT();
  const play = useUi((state) => state.play);
  const navigate = useNavigate();
  const hasSource = useLibrary((state) => (state.sources[unitKey]?.length ?? 0) > 0);
  const { title } = progress;
  const art = imageUrl(title.backdrop, "w780") ?? imageUrl(title.poster, "w342");
  const episodeLabel =
    progress.season !== undefined
      ? t("common.seasonEpisode", { season: progress.season, episode: progress.episode ?? "" })
      : t("common.type.movie");

  const openTitle = () => navigate(`/title/${title.type}/${title.id}`);
  const resume = () => {
    if (!hasSource) {
      openTitle();
      return;
    }
    play({
      title,
      unitKey,
      season: progress.season,
      episode: progress.episode,
      episodeName: progress.episodeName,
    });
  };

  return (
    <div className="continue-card">
      <button className="continue-card__art" aria-label={t("home.continue.resume", { title: title.title })} onClick={resume}>
        {art && <img src={art} alt="" loading="lazy" draggable={false} />}
        <span className="continue-card__play">
          <Play size={22} fill="currentColor" />
        </span>
        <div className="bar bar--thin">
          <i style={{ width: `${(progress.position / progress.duration) * 100}%` }} />
        </div>
      </button>
      <button className="continue-card__info" aria-label={t("home.continue.page", { title: title.title })} title={t("common.openPage")} onClick={openTitle}>
        <Info size={16} />
      </button>
      <button className="continue-card__text" onClick={openTitle}>
        <div className="poster-card__title">{title.title}</div>
        <div className="poster-card__meta">
          <span>{episodeLabel}</span>
          {progress.duration > secondsPerMinute && <span>{remainingLabel(progress)}</span>}
        </div>
      </button>
    </div>
  );
}

function ContinueRow() {
  const { t } = useT();
  const progress = useLibrary((state) => state.progress);
  const entries = useMemo(
    () =>
      Object.entries(progress)
        .filter(([, item]) => item.position >= minResumeSeconds && !isWatched(item))
        .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
        .slice(0, continueRowLimit),
    [progress],
  );
  if (entries.length === 0) return null;
  return (
    <Row title={t("home.row.continue")}>
      {entries.map(([key, item]) => (
        <ContinueCard key={key} unitKey={key} progress={item} />
      ))}
    </Row>
  );
}

function UpNextCard({ item }: { item: UpNextEpisode }) {
  const { t } = useT();
  const play = useUi((state) => state.play);
  const navigate = useNavigate();
  const hasSource = useLibrary((state) => (state.sources[item.unitKey]?.length ?? 0) > 0);
  const art = imageUrl(item.still, "w500") ?? imageUrl(item.title.backdrop, "w780") ?? imageUrl(item.title.poster, "w342");
  const openTitle = () => navigate(`/title/tv/${item.title.id}?s=${item.season}`);
  const start = () => {
    if (!hasSource) {
      openTitle();
      return;
    }
    play({ title: item.title, unitKey: item.unitKey, season: item.season, episode: item.episode, episodeName: item.name });
  };

  return (
    <div className="continue-card">
      <button
        className="continue-card__art"
        aria-label={hasSource ? t("home.upNext.play", { title: item.title.title }) : t("home.upNext.find", { title: item.title.title })}
        onClick={start}
      >
        {art && <img src={art} alt="" loading="lazy" draggable={false} />}
        <span className="continue-card__play">
          <Play size={22} fill="currentColor" />
        </span>
      </button>
      <button className="continue-card__info" aria-label={t("home.continue.page", { title: item.title.title })} title={t("common.openPage")} onClick={openTitle}>
        <Info size={16} />
      </button>
      <button className="continue-card__text" onClick={openTitle}>
        <div className="poster-card__title">{item.title.title}</div>
        <div className="poster-card__meta">
          <span>{t("common.seasonEpisode", { season: item.season, episode: item.episode })}</span>
          <span>{hasSource ? item.name : t("home.upNext.noSource")}</span>
        </div>
      </button>
    </div>
  );
}

function UpNextRow() {
  const { t } = useT();
  const items = useUpNext();
  if (!items || items.length === 0) return null;
  return (
    <Row title={t("home.row.upNext")}>
      {items.map((item) => (
        <UpNextCard key={item.unitKey} item={item} />
      ))}
    </Row>
  );
}

function NewEpisodesRow() {
  const { t, tn } = useT();
  const calendar = useEpisodeCalendar();
  const progress = useLibrary((state) => state.progress);
  const items = useMemo(() => {
    const bySeries = new Map<number, CalendarEpisode[]>();
    for (const episode of calendar.episodes ?? []) {
      if (!isNewEpisode(episode, progress, calendar.today)) continue;
      bySeries.set(episode.title.id, [...(bySeries.get(episode.title.id) ?? []), episode]);
    }
    const latest = (episodes: CalendarEpisode[]) => episodes[episodes.length - 1];
    return [...bySeries.values()]
      .sort((a, b) => latest(b).airDate.localeCompare(latest(a).airDate))
      .map((episodes) => ({
        ...episodes[0].title,
        note:
          episodes.length === 1
            ? t("common.seasonEpisode", { season: episodes[0].season, episode: episodes[0].episode })
            : tn("calendar.new.count", episodes.length),
      }));
  }, [calendar.episodes, calendar.today, progress, t, tn]);
  return <PosterRow title={t("home.row.newEpisodes")} items={items} />;
}

function dismissRecommendation(title: TitleRef): void {
  const { dismiss, restoreDismissed } = useLibrary.getState();
  dismiss(title);
  useUi.getState().toast(t("feed.dismissed", { title: title.title }), "info", {
    label: t("feed.dismissed.undo"),
    run: () => restoreDismissed(titleKey(title.type, title.id)),
  });
}

export default function Home() {
  const { t } = useT();
  const trending = useAsync(tmdb.trending, []);
  const movies = useAsync(tmdb.popularMovies, []);
  const series = useAsync(tmdb.popularSeries, []);
  const anime = useAsync(tmdb.anime, []);
  const nowPlaying = useAsync(tmdb.nowPlaying, []);
  const topMovies = useAsync(tmdb.topMovies, []);
  const topSeries = useAsync(tmdb.topSeries, []);
  const animeMovies = useAsync(tmdb.animeMovies, []);
  const tracked = useLibrary((state) => state.tracked);
  const feed = usePersonalFeed();
  const planned = useMemo(
    () =>
      Object.values(tracked)
        .filter((entry) => entry.status === "planned")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(entryToRef),
    [tracked],
  );

  if (trending.error) {
    return (
      <div className="page">
        <ContinueRow />
        <CatalogError onRetry={trending.reload} />
      </div>
    );
  }

  return (
    <div className="page page--flush">
      <Hero items={trending.data ?? []} />
      <div className="page__rows">
        <ContinueRow />
        <UpNextRow />
        <NewEpisodesRow />
        {feed.available && feed.rows === null && <PosterRow title={t("feed.forYou")} items={null} />}
        {feed.rows?.map((row) => <PosterRow key={row.id} title={row.title} items={row.items} onDismiss={dismissRecommendation} />)}
        {planned.length > 0 && <PosterRow title={t("home.row.planned")} items={planned} />}
        <PosterRow title={t("home.row.trending")} items={trending.data} />
        <PosterRow title={t("home.row.nowPlaying")} items={nowPlaying.data} />
        <PosterRow title={t("home.row.popularSeries")} items={series.data} />
        <PosterRow title={t("home.row.anime")} items={anime.data} />
        <PosterRow title={t("home.row.popularMovies")} items={movies.data} />
        <PosterRow title={t("home.row.animeMovies")} items={animeMovies.data} />
        <PosterRow title={t("home.row.topMovies")} items={topMovies.data} />
        <PosterRow title={t("home.row.topSeries")} items={topSeries.data} />
      </div>
    </div>
  );
}
