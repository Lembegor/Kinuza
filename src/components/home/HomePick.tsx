import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Clapperboard, Clock, Dices, Play, ThumbsDown, X } from "lucide-react";
import { DismissChoices, typeLabel, useDismissOutside, type DismissDetail } from "../Cards";
import { CatalogRating } from "../CatalogRating";
import { TrailerOverlay } from "../TrailerOverlay";
import { t, useT } from "../../lib/i18n";
import { cachedCatalog } from "../../lib/persistentCache";
import { imageUrl, tmdb, type MediaItem } from "../../lib/tmdb";
import { useAsync } from "../../lib/useAsync";
import { recordActivity, titleOf } from "../../state/activity";
import { titleKey, toTitleRef, useLibrary } from "../../state/library";
import { applyStatus } from "../../state/titleStatus";

const detailsMaxAgeMs = 3 * 86_400_000;
const minutesPerHour = 60;
const shownGenres = 2;

export type PickMode = "pick" | "popular" | "surprise";

export interface PickSlide extends MediaItem {
  note?: string;
}

function runtimeLabel(minutes: number): string {
  const hours = Math.floor(minutes / minutesPerHour);
  return hours > 0 ? t("common.duration.hoursMinutes", { hours, minutes: minutes % minutesPerHour }) : t("common.duration.minutes", { minutes });
}

function PlannedButton({ item }: { item: MediaItem }) {
  const { t } = useT();
  const entry = useLibrary((state) => state.tracked[titleKey(item.type, item.id)]);
  const planned = entry?.status === "planned";
  const toggle = () => {
    const ref = toTitleRef(item);
    if (!planned) {
      applyStatus(ref, "planned");
      return;
    }
    if (!entry?.rating && !entry?.liked) useLibrary.getState().removeTracked(titleKey(item.type, item.id));
    else applyStatus(ref, null);
  };
  return (
    <button className={`button button--large home-pick__soft ${planned ? "is-on" : ""}`} aria-pressed={planned} onClick={toggle}>
      <Clock size={18} />
      <span className="home-pick__label">{planned ? t("home.pick.planned") : t("home.pick.plan")}</span>
    </button>
  );
}

export function HomePick({
  slides,
  mode,
  onDismiss,
  onReroll,
  onLeave,
}: {
  slides: PickSlide[];
  mode: PickMode;
  onDismiss?: (item: PickSlide, detail: DismissDetail) => void;
  onReroll?: () => void;
  onLeave?: () => void;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const [asking, setAsking] = useState(false);
  const [trailer, setTrailer] = useState(false);
  const askRef = useRef<HTMLDivElement>(null);
  const closeAsk = useCallback(() => setAsking(false), []);
  useDismissOutside(asking, askRef, closeAsk);
  const current = slides[Math.min(index, slides.length - 1)];

  useEffect(() => {
    if (index >= slides.length && slides.length > 0) setIndex(slides.length - 1);
  }, [index, slides.length]);

  const details = useAsync(
    () => (current ? cachedCatalog(`details:${current.type}:${current.id}`, detailsMaxAgeMs, () => tmdb.details(current.type, current.id)) : Promise.resolve(null)),
    [current?.type, current?.id],
    current ? `home-pick:${current.type}:${current.id}` : undefined,
  );

  if (!current) return <section className="home-pick home-pick--skeleton" aria-hidden="true" />;
  const info = details.data;
  const backdrop = imageUrl(current.backdrop ?? info?.backdrop ?? null, "w1280");
  const overview = current.overview || info?.overview || "";
  const genres = (info?.genres ?? []).slice(0, shownGenres);
  const step = (direction: 1 | -1) => setIndex((value) => (value + direction + slides.length) % slides.length);
  const open = () => navigate(`/title/${current.type}/${current.id}`);
  const kicker = mode === "surprise" ? t("home.pick.surprise") : mode === "popular" ? t("home.pick.popular") : t("home.pick.today");

  return (
    <section
      className="home-pick"
      aria-roledescription={t("home.pick.region")}
      aria-label={kicker}
      onKeyDown={(event) => {
        if (trailer || !event.currentTarget.contains(event.target as Node)) return;
        if (slides.length < 2 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        if ((event.target as HTMLElement).closest(".dismiss-menu")) return;
        event.preventDefault();
        step(event.key === "ArrowRight" ? 1 : -1);
      }}
    >
      {backdrop && <img key={`${current.type}:${current.id}`} className="home-pick__backdrop" src={backdrop} alt="" draggable={false} />}
      <div className="home-pick__shade" />
      <div className="home-pick__body">
        <div className="home-pick__kicker">
          <span className={`home-pick__pill ${mode === "pick" ? "" : "is-soft"}`}>{kicker}</span>
          {current.note && <span>{current.note}</span>}
        </div>
        <h1>
          <button onClick={open}>{current.title}</button>
        </h1>
        <div className="home-pick__meta">
          <CatalogRating type={current.type} id={current.id} rating={current.rating} className="rating" size={12} />
          <span>{typeLabel(current)}</span>
          {current.year && <span>{current.year}</span>}
          {genres.length > 0 && <span>{genres.join(", ").toLowerCase()}</span>}
          {info?.runtimeMinutes ? <span>{runtimeLabel(info.runtimeMinutes)}</span> : null}
        </div>
        {overview && <p>{overview}</p>}
        <div className="home-pick__actions">
          <button className="button button--primary button--large" onClick={open}>
            <Play size={18} fill="currentColor" />
            {t("home.pick.watch")}
          </button>
          <PlannedButton item={current} />
          {info && info.videos.length > 0 && (
            <button className="button button--large home-pick__soft home-pick__trailer" aria-label={t("home.pick.trailer")} title={t("home.pick.trailer")} onClick={() => setTrailer(true)}>
              <Clapperboard size={18} />
              <span className="home-pick__label">{t("home.pick.trailer")}</span>
            </button>
          )}
          {mode === "surprise" ? (
            <button className="button button--large home-pick__soft" onClick={onReroll}>
              <Dices size={18} />
              <span className="home-pick__label">{t("home.pick.again")}</span>
            </button>
          ) : (
            onDismiss && (
              <div className="home-pick__ask" ref={askRef}>
                <button
                  className="button button--large home-pick__soft home-pick__icon"
                  aria-label={t("feed.dismiss.label", { title: current.title })}
                  title={t("feed.dismiss")}
                  aria-expanded={asking}
                  onClick={() => setAsking((value) => !value)}
                >
                  <ThumbsDown size={18} />
                </button>
                {asking && (
                  <DismissChoices
                    item={current}
                    onChoose={(detail) => {
                      setAsking(false);
                      onDismiss(current, detail);
                    }}
                  />
                )}
              </div>
            )
          )}
        </div>
      </div>
      {mode === "surprise" && onLeave && (
        <button className="icon-button home-pick__leave" aria-label={t("home.pick.leave")} title={t("home.pick.leave")} onClick={onLeave}>
          <X size={18} />
        </button>
      )}
      {slides.length > 1 && (
        <div className="home-pick__nav">
          <span className="home-pick__count">{t("home.pick.count", { index: index + 1, total: slides.length })}</span>
          <button className="home-pick__arrow" aria-label={t("home.hero.previous")} onClick={() => step(-1)}>
            <ChevronLeft size={18} />
          </button>
          <div className="home-pick__thumbs">
            {slides.map((slide, slideIndex) => (
              <button
                key={`${slide.type}:${slide.id}`}
                className={slideIndex === index ? "is-active" : ""}
                aria-label={slide.title}
                aria-current={slideIndex === index}
                onClick={() => setIndex(slideIndex)}
              >
                {slide.backdrop ? <img src={imageUrl(slide.backdrop, "w300") ?? undefined} alt="" draggable={false} /> : <span>{slide.title}</span>}
              </button>
            ))}
          </div>
          <button className="home-pick__arrow" aria-label={t("home.hero.next")} onClick={() => step(1)}>
            <ChevronRight size={18} />
          </button>
        </div>
      )}
      {trailer && info && (
        <TrailerOverlay
          title={info.title}
          videos={info.videos}
          onClose={() => setTrailer(false)}
          onWatched={(watch) => recordActivity("trailer", { title: titleOf(toTitleRef(current)), ...watch })}
        />
      )}
    </section>
  );
}
