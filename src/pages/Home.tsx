import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Info, Play, Star } from "lucide-react";
import { CatalogError, PosterRow, Row, typeLabel } from "../components/Cards";
import { imageUrl, tmdb, type MediaItem } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { entryToRef, isWatched, useLibrary, type Progress } from "../state/library";
import { useUi } from "../state/ui";

const heroRotationMs = 10000;
const heroItemCount = 6;
/** Progress shorter than this is treated as an accidental start, not something to resume. */
const minResumeSeconds = 30;
const continueRowLimit = 12;

function Hero({ items }: { items: MediaItem[] }) {
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const slides = useMemo(() => items.filter((item) => item.backdrop && item.overview).slice(0, heroItemCount), [items]);

  useEffect(() => {
    if (slides.length < 2) return;
    const timer = setInterval(() => setIndex((value) => (value + 1) % slides.length), heroRotationMs);
    return () => clearInterval(timer);
  }, [slides.length]);

  const current = slides[index];
  if (!current) return <div className="hero hero--skeleton" />;

  return (
    <section className="hero">
      {slides.map((slide, slideIndex) => (
        <img
          key={slide.id}
          className={`hero__backdrop ${slideIndex === index ? "is-active" : ""}`}
          src={imageUrl(slide.backdrop, "w1280") ?? undefined}
          alt=""
          draggable={false}
        />
      ))}
      <div className="hero__shade" />
      <div className="hero__body" key={current.id}>
        <div className="hero__kicker">
          <span>В тренде</span>
          <span>{typeLabel(current)}</span>
          {current.year && <span>{current.year}</span>}
          {current.rating > 0 && (
            <span className="rating">
              <Star size={12} fill="currentColor" />
              {current.rating.toFixed(1)}
            </span>
          )}
        </div>
        <h1>{current.title}</h1>
        <p>{current.overview}</p>
        <div className="hero__actions">
          <button className="button button--primary button--large" onClick={() => navigate(`/title/${current.type}/${current.id}`)}>
            <Info size={18} />
            Подробнее
          </button>
        </div>
      </div>
      <div className="hero__dots">
        {slides.map((slide, slideIndex) => (
          <button
            key={slide.id}
            aria-label={slide.title}
            className={slideIndex === index ? "is-active" : ""}
            onClick={() => setIndex(slideIndex)}
          />
        ))}
      </div>
    </section>
  );
}

function ContinueCard({ unitKey, progress }: { unitKey: string; progress: Progress }) {
  const play = useUi((state) => state.play);
  const navigate = useNavigate();
  const hasSource = useLibrary((state) => (state.sources[unitKey]?.length ?? 0) > 0);
  const { title } = progress;
  const art = imageUrl(title.backdrop, "w780") ?? imageUrl(title.poster, "w342");
  const episodeLabel = progress.season !== undefined ? `Сезон ${progress.season} · Серия ${progress.episode}` : "Фильм";

  const open = () => {
    if (!hasSource) {
      navigate(`/title/${title.type}/${title.id}`);
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
    <button className="continue-card" onClick={open}>
      <div className="continue-card__art">
        {art && <img src={art} alt="" loading="lazy" draggable={false} />}
        <span className="continue-card__play">
          <Play size={22} fill="currentColor" />
        </span>
        <div className="bar bar--thin">
          <i style={{ width: `${(progress.position / progress.duration) * 100}%` }} />
        </div>
      </div>
      <div className="poster-card__title">{title.title}</div>
      <div className="poster-card__meta">
        <span>{episodeLabel}</span>
      </div>
    </button>
  );
}

function ContinueRow() {
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
    <Row title="Продолжить просмотр">
      {entries.map(([key, item]) => (
        <ContinueCard key={key} unitKey={key} progress={item} />
      ))}
    </Row>
  );
}

export default function Home() {
  const trending = useAsync(tmdb.trending, []);
  const movies = useAsync(tmdb.popularMovies, []);
  const series = useAsync(tmdb.popularSeries, []);
  const anime = useAsync(tmdb.anime, []);
  const nowPlaying = useAsync(tmdb.nowPlaying, []);
  const topMovies = useAsync(tmdb.topMovies, []);
  const topSeries = useAsync(tmdb.topSeries, []);
  const animeMovies = useAsync(tmdb.animeMovies, []);
  const tracked = useLibrary((state) => state.tracked);
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
        {planned.length > 0 && <PosterRow title="Запланировано" items={planned} />}
        <PosterRow title="Сейчас в тренде" items={trending.data} />
        <PosterRow title="Сейчас в кино" items={nowPlaying.data} />
        <PosterRow title="Популярные сериалы" items={series.data} />
        <PosterRow title="Аниме" items={anime.data} />
        <PosterRow title="Популярные фильмы" items={movies.data} />
        <PosterRow title="Аниме-фильмы" items={animeMovies.data} />
        <PosterRow title="Лучшие фильмы" items={topMovies.data} />
        <PosterRow title="Лучшие сериалы" items={topSeries.data} />
      </div>
    </div>
  );
}
