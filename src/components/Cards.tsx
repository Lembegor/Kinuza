// Poster cards, horizontal rows and shared loading/error placeholders.

import { useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, CloudOff, Star } from "lucide-react";
import { hasApiKey, imageUrl, type MediaItem } from "../lib/tmdb";
import type { TitleRef } from "../state/library";
import { TrackBadge } from "./TrackControls";

/** `note` replaces the year and type line, e.g. with episode progress. */
type CardItem = TitleRef & Partial<Pick<MediaItem, "rating" | "isAnime">> & { note?: string };

export function typeLabel(item: Pick<CardItem, "type" | "isAnime">): string {
  if (item.isAnime) return "Аниме";
  return item.type === "movie" ? "Фильм" : "Сериал";
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

export function Row({ title, children }: { title: string; children: ReactNode }) {
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
          <button aria-label="Назад" onClick={() => scroll(-1)}>
            <ChevronLeft size={18} />
          </button>
          <button aria-label="Вперёд" onClick={() => scroll(1)}>
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

export function PosterRow({ title, items }: { title: string; items: CardItem[] | null }) {
  if (items && items.length === 0) return null;
  return (
    <Row title={title}>
      {items
        ? items.map((item) => <PosterCard key={`${item.type}:${item.id}`} item={item} />)
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
  return (
    <div className="empty">
      <CloudOff size={40} />
      <h2>Каталог недоступен</h2>
      <p>
        {hasApiKey()
          ? "Не получилось связаться с TMDB. Проверьте интернет; в некоторых сетях каталог открывается только через VPN."
          : "Не задан ключ TMDB. Укажите его в настройках."}
      </p>
      <button className="button button--primary" onClick={onRetry}>
        Повторить
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
