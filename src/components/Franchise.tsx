// The franchise a film belongs to: all its parts in release order, with what the user has seen.

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Star } from "lucide-react";
import { useT } from "../lib/i18n";
import { imageUrl, tmdb, type CollectionPart } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { isWatched, titleKey, unitKey, useLibrary } from "../state/library";
import { Row } from "./Cards";

/** A "franchise" of one film has nowhere to lead. */
const minParts = 2;
const skeletonCount = 5;
const isoDateLength = "2000-01-01".length;

function isReleased(part: CollectionPart): boolean {
  return part.releaseDate !== "" && part.releaseDate <= new Date().toISOString().slice(0, isoDateLength);
}

function FranchiseCard({ part, current }: { part: CollectionPart; current: boolean }) {
  const { t } = useT();
  const navigate = useNavigate();
  const cardRef = useRef<HTMLButtonElement>(null);
  // Seen in the player, or marked as completed by hand.
  const watched = useLibrary(
    (state) => isWatched(state.progress[unitKey("movie", part.id)]) || state.tracked[titleKey("movie", part.id)]?.status === "completed",
  );
  const released = isReleased(part);
  const poster = imageUrl(part.poster, "w342");

  // A long franchise opens on the film being looked at, not on its first part. Only the row is
  // scrolled: scrollIntoView would also move the page.
  useEffect(() => {
    const card = cardRef.current;
    const track = card?.parentElement;
    if (current && card && track) track.scrollLeft = card.offsetLeft - track.offsetLeft - (track.clientWidth - card.clientWidth) / 2;
  }, [current]);

  return (
    <button
      ref={cardRef}
      className={`poster-card franchise-card ${current ? "is-current" : ""} ${released ? "" : "is-upcoming"}`}
      aria-current={current ? "page" : undefined}
      disabled={current}
      onClick={() => navigate(`/title/movie/${part.id}`)}
    >
      <div className="poster-card__art">
        {poster ? <img src={poster} alt="" loading="lazy" draggable={false} /> : <div className="poster-card__blank">{part.title}</div>}
        {released && part.rating > 0 && (
          <span className="poster-card__rating">
            <Star size={11} fill="currentColor" />
            {part.rating.toFixed(1)}
          </span>
        )}
        {watched && (
          <span className="franchise-card__seen" title={t("collection.watched")}>
            <Check size={13} />
          </span>
        )}
        {current && <span className="franchise-card__here">{t("collection.current")}</span>}
      </div>
      <div className="poster-card__title">{part.title}</div>
      <div className="poster-card__meta">
        {part.year && <span>{part.year}</span>}
        {!released && <span>{t("collection.soon")}</span>}
        {released && watched && <span>{t("collection.watched")}</span>}
      </div>
    </button>
  );
}

export function FranchiseRow({ collection, currentId }: { collection: { id: number; name: string }; currentId: number }) {
  const loaded = useAsync(() => tmdb.collection(collection.id), [collection.id]);
  const parts = loaded.data && loaded.data.id === collection.id ? loaded.data.parts : null;

  // The row is an extra: when it cannot be loaded the page is complete without it.
  if (loaded.error || (parts && parts.length < minParts)) return null;
  return (
    <Row title={collection.name}>
      {parts
        ? parts.map((part) => <FranchiseCard key={part.id} part={part} current={part.id === currentId} />)
        : Array.from({ length: skeletonCount }, (_, index) => <div key={index} className="poster-card poster-card--skeleton" />)}
    </Row>
  );
}
