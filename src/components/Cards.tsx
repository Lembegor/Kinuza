import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronLeft, ChevronRight, Clock, CloudOff, LoaderCircle, Star, ThumbsDown } from "lucide-react";
import type { Dismissal } from "../lib/account";
import { useCardTitle } from "../lib/catalog";
import { t, useT } from "../lib/i18n";
import { cachedCatalog } from "../lib/persistentCache";
import { hasApiKey, imageUrl, tmdb, type MediaItem } from "../lib/tmdb";
import { maxRating, titleKey, unitKey, useLibrary, type TitleRef, type WatchStatus } from "../state/library";
import { TrackBadge } from "./TrackControls";

type CardItem = TitleRef & Partial<Pick<MediaItem, "rating" | "isAnime">> & { note?: string };

export function typeLabel(item: Pick<CardItem, "type" | "isAnime">): string {
  if (item.isAnime) return t("common.type.anime");
  return item.type === "movie" ? t("common.type.movie") : t("common.type.series");
}

function refOf(item: CardItem): TitleRef {
  const { type, id, title, poster, backdrop, year } = item;
  return { type, id, title, poster, backdrop, year };
}

function changeStatus(item: CardItem, status: WatchStatus | null): void {
  const title = refOf(item);
  const key = titleKey(title.type, title.id);
  const state = useLibrary.getState();
  const previous = state.tracked[key];
  const movieKey = unitKey("movie", title.id);
  const leavingCompleted = previous?.status === "completed" && status !== "completed";
  if (status === null && !previous?.rating && !previous?.liked) state.removeTracked(key);
  else state.setStatus(title, status);
  if (title.type !== "movie") return;
  if (status === "completed") state.setWatched(movieKey, true, { title });
  else if (leavingCompleted && state.progress[movieKey]) state.setWatched(movieKey, false, { title });
}

export function QuickActions({ item }: { item: CardItem }) {
  const { t } = useT();
  const entry = useLibrary((state) => state.tracked[titleKey(item.type, item.id)]);
  const [rating, setRating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const status = entry?.status ?? null;

  useEffect(() => {
    if (!rating) return;
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setRating(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRating(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [rating]);

  const rate = (value: number) => {
    useLibrary.getState().setRating(refOf(item), value === entry?.rating ? null : value);
    setRating(false);
  };

  return (
    <div className={`poster-actions ${rating ? "is-open" : ""}`} ref={ref}>
      {rating && (
        <div className="poster-actions__rating" role="group" aria-label={t("library.rating.mine")}>
          {Array.from({ length: maxRating }, (_, index) => index + 1).map((value) => (
            <button
              key={value}
              className={entry?.rating === value ? "is-on" : ""}
              aria-pressed={entry?.rating === value}
              title={t("library.rating.value", { value })}
              onClick={() => rate(value)}
            >
              {value}
            </button>
          ))}
        </div>
      )}
      <div className="poster-actions__bar">
        <button
          className={status === "planned" ? "is-on" : ""}
          aria-pressed={status === "planned"}
          aria-label={t("cards.quick.planned", { title: item.title })}
          title={t("status.planned")}
          onClick={() => changeStatus(item, status === "planned" ? null : "planned")}
        >
          <Clock size={15} />
        </button>
        <button
          className={status === "completed" ? "is-on" : ""}
          aria-pressed={status === "completed"}
          aria-label={t("cards.quick.completed", { title: item.title })}
          title={t("status.completed")}
          onClick={() => changeStatus(item, status === "completed" ? null : "completed")}
        >
          <Check size={15} />
        </button>
        <button
          className={entry?.rating ? "is-on" : ""}
          aria-expanded={rating}
          aria-label={t("cards.quick.rate", { title: item.title })}
          title={entry?.rating ? t("library.rating.outOf", { value: entry.rating, max: maxRating }) : t("library.rating.mine")}
          onClick={() => setRating((open) => !open)}
        >
          <Star size={15} fill={entry?.rating ? "currentColor" : "none"} />
          {entry?.rating ? <small>{entry.rating}</small> : null}
        </button>
      </div>
    </div>
  );
}

export type DismissDetail = Pick<Dismissal, "reason" | "personId" | "personName">;

export function PosterCard({ item }: { item: CardItem }) {
  const navigate = useNavigate();
  const poster = imageUrl(item.poster, "w342");
  const title = useCardTitle(item.type, item.id, item.title);
  return (
    <div className="poster-card">
      <button className="poster-card__open" onClick={() => navigate(`/title/${item.type}/${item.id}`)}>
      <div className="poster-card__art">
        {poster ? <img src={poster} alt="" loading="lazy" draggable={false} /> : <div className="poster-card__blank">{title}</div>}
        {item.rating ? (
          <span className="poster-card__rating">
            <Star size={11} fill="currentColor" />
            {item.rating.toFixed(1)}
          </span>
        ) : null}
        <TrackBadge type={item.type} id={item.id} />
      </div>
      <div className="poster-card__title">{title}</div>
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
      <QuickActions item={item} />
    </div>
  );
}

const shownPeople = 4;

function DismissibleCard({ item, onDismiss }: { item: CardItem; onDismiss: (item: CardItem, detail: DismissDetail) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<{ id: number; name: string }[] | null>(null);
  const [loadingPeople, setLoadingPeople] = useState(false);
  const slotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!slotRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const finish = (detail: DismissDetail) => {
    const slot = slotRef.current;
    const neighbour = slot?.nextElementSibling ?? slot?.previousElementSibling;
    neighbour?.querySelector<HTMLElement>(".poster-card__open")?.focus();
    setOpen(false);
    onDismiss(item, detail);
  };

  const askPeople = async () => {
    setLoadingPeople(true);
    try {
      const taste = await cachedCatalog(`taste:${item.type}:${item.id}`, 14 * 86_400_000, () => tmdb.taste(item.type, item.id));
      setPeople(taste.people.slice(0, shownPeople).map(({ id, name }) => ({ id, name })));
    } catch {
      setPeople([]);
    } finally {
      setLoadingPeople(false);
    }
  };

  return (
    <div className={`poster-slot ${open ? "is-asking" : ""}`} ref={slotRef}>
      <PosterCard item={item} />
      <button
        className="poster-slot__dismiss"
        title={t("feed.dismiss")}
        aria-label={t("feed.dismiss.label", { title: item.title })}
        aria-expanded={open}
        onClick={() => {
          setPeople(null);
          setOpen((value) => !value);
        }}
      >
        <ThumbsDown size={15} />
      </button>
      {open && (
        <div className="dismiss-menu" role="menu" aria-label={t("feed.dismiss.why")}>
          <strong>{t("feed.dismiss.why")}</strong>
          {people === null ? (
            <>
              <button role="menuitem" onClick={() => finish({ reason: "seen" })}>
                {t("feed.dismiss.seen")}
              </button>
              <button role="menuitem" onClick={() => finish({ reason: "genre" })}>
                {t("feed.dismiss.genre")}
              </button>
              <button role="menuitem" disabled={loadingPeople} onClick={() => void askPeople()}>
                {t("feed.dismiss.person")}
                {loadingPeople && <LoaderCircle size={13} className="spin" />}
              </button>
              <button role="menuitem" onClick={() => finish({ reason: "other" })}>
                {t("feed.dismiss.other")}
              </button>
            </>
          ) : (
            <>
              {people.map((person) => (
                <button key={person.id} role="menuitem" onClick={() => finish({ reason: "person", personId: person.id, personName: person.name })}>
                  {person.name}
                </button>
              ))}
              <button role="menuitem" onClick={() => finish({ reason: "other" })}>
                {people.length > 0 ? t("feed.dismiss.nobody") : t("feed.dismiss.other")}
              </button>
            </>
          )}
        </div>
      )}
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

export function PosterRow({
  title,
  items,
  onDismiss,
}: {
  title: string;
  items: CardItem[] | null;
  onDismiss?: (item: TitleRef, detail: DismissDetail) => void;
}) {
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
