import { useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, CloudOff, Star, ThumbsDown } from "lucide-react";
import { t, useT } from "../lib/i18n";
import { hasApiKey, imageUrl, type MediaItem } from "../lib/tmdb";
import type { TitleRef } from "../state/library";
import { TrackBadge } from "./TrackControls";

type CardItem = TitleRef & Partial<Pick<MediaItem, "rating" | "isAnime">> & { note?: string };

export function typeLabel(item: Pick<CardItem, "type" | "isAnime">): string {
  if (item.isAnime) return t("common.type.anime");
  return item.type === "movie" ? t("common.type.movie") : t("common.type.series");
}

export function PosterCard({ item }: { item: CardItem }) {
  const navigate = useNavigate();
  const poster = imageUrl(item.poster, "w342");
  return (
    <button className="poster-card" onClick={() => navigate(`/title/${item.type}/${item.id}`)}>
      <div className="poster-card__art">
        {poster ? <img src={poster} alt="" loading="lazy" draggable={false} /> : <div className="poster-card__blank">{item.title}</div>}
        {item.rating ? (
          <span className="poster-card__rating">
            <Star size={11} fill="currentColor" />
            {item.rating.toFixed(1)}
          </span>
        ) : null}
        <TrackBadge type={item.type} id={item.id} />
      </div>
      <div className="poster-card__title">{item.title}</div>
      <div className="poster-card__meta">
        {item.note ? (
          <span>{item.note}</span>
        ) : (
          <>
            {item.year && <span>{item.year}</span>}
            <span>{typeLabel(item)}</span>
          </>
        )}
      </div>
    </button>
  );
}

function DismissibleCard({ item, onDismiss }: { item: CardItem; onDismiss: (item: CardItem) => void }) {
  const { t } = useT();
  return (
    <div className="poster-slot">
      <PosterCard item={item} />
      <button
        className="poster-slot__dismiss"
        title={t("feed.dismiss")}
        aria-label={t("feed.dismiss.label", { title: item.title })}
        onClick={(event) => {
          const slot = event.currentTarget.parentElement;
          const neighbour = slot?.nextElementSibling ?? slot?.previousElementSibling;
          neighbour?.querySelector<HTMLElement>(".poster-card")?.focus();
          onDismiss(item);
        }}
      >
        <ThumbsDown size={15} />
      </button>
    </div>
  );
}

export function Row({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useT();
  const trackRef = useRef<HTMLDivElement>(null);
  const scroll = (direction: 1 | -1) => {
    const track = trackRef.current;
    if (track) track.scrollBy({ left: direction * track.clientWidth * 0.85, behavior: "smooth" });
  };
  return (
    <section className="row">
      <div className="row__head">
        <h2>{title}</h2>
        <div className="row__arrows">
          <button aria-label={t("common.back")} onClick={() => scroll(-1)}>
            <ChevronLeft size={18} />
          </button>
          <button aria-label={t("common.forward")} onClick={() => scroll(1)}>
            <ChevronRight size={18} />
          </button>
        </div>
      </div>
      <div className="row__track" ref={trackRef}>
        {children}
      </div>
    </section>
  );
}

export function PosterRow({ title, items, onDismiss }: { title: string; items: CardItem[] | null; onDismiss?: (item: TitleRef) => void }) {
  if (items && items.length === 0) return null;
  return (
    <Row title={title}>
      {items
        ? items.map((item) =>
            onDismiss ? (
              <DismissibleCard key={`${item.type}:${item.id}`} item={item} onDismiss={onDismiss} />
            ) : (
              <PosterCard key={`${item.type}:${item.id}`} item={item} />
            ),
          )
        : Array.from({ length: 9 }, (_, index) => <div key={index} className="poster-card poster-card--skeleton" />)}
    </Row>
  );
}

export function PosterGrid({ items }: { items: CardItem[] }) {
  return (
    <div className="poster-grid">
      {items.map((item) => (
        <PosterCard key={`${item.type}:${item.id}`} item={item} />
      ))}
    </div>
  );
}

export function CatalogError({ onRetry }: { onRetry: () => void }) {
  const { t } = useT();
  return (
    <div className="empty">
      <CloudOff size={40} />
      <h2>{t("errors.catalog.title")}</h2>
      <p>
        {hasApiKey() ? t("errors.catalog.network") : t("errors.catalog.noKey")}
      </p>
      <button className="button button--primary" onClick={onRetry}>
        {t("common.retry")}
      </button>
    </div>
  );
}

export function EmptyState({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="empty">
      {icon}
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
