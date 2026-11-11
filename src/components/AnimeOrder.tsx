// The parts of an anime franchise in the order they came out: seasons, films and OVAs, which the
// general catalog folds into one series or scatters without a link between them.

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { animeInfo, type AnimeFormat, type AnimePart } from "../lib/anilist";
import { useT, type MessageKey } from "../lib/i18n";
import { useAsync } from "../lib/useAsync";
import { Row } from "./Cards";

/** One part is the title itself; there is no order to show. */
const minParts = 2;

const formatLabels: Record<AnimeFormat, MessageKey> = {
  TV: "anime.format.tv",
  TV_SHORT: "anime.format.tv",
  MOVIE: "anime.format.movie",
  OVA: "anime.format.ova",
  ONA: "anime.format.ona",
  SPECIAL: "anime.format.special",
};

function AnimeCard({ part, current }: { part: AnimePart; current: boolean }) {
  const { t, tn } = useT();
  const navigate = useNavigate();
  const cardRef = useRef<HTMLButtonElement>(null);
  const name = part.english || part.romaji;

  // A long franchise opens on the part being looked at. Only the row is scrolled.
  useEffect(() => {
    const card = cardRef.current;
    const track = card?.parentElement;
    if (current && card && track) track.scrollLeft = card.offsetLeft - track.offsetLeft - (track.clientWidth - card.clientWidth) / 2;
  }, [current]);

  return (
    <button
      ref={cardRef}
      className={`poster-card franchise-card ${current ? "is-current" : ""} ${part.startDate ? "" : "is-upcoming"}`}
      aria-current={current ? "page" : undefined}
      disabled={current}
      title={part.romaji}
      // The catalog knows these parts under its own numbers; the name finds the right page.
      onClick={() => navigate(`/search?q=${encodeURIComponent(name)}`)}
    >
      <div className="poster-card__art">
        {part.cover ? <img src={part.cover} alt="" loading="lazy" draggable={false} /> : <div className="poster-card__blank">{name}</div>}
        <span className="anime-card__format">{t(formatLabels[part.format])}</span>
        {current && <span className="franchise-card__here">{t("anime.order.current")}</span>}
      </div>
      <div className="poster-card__title">{name}</div>
      <div className="poster-card__meta">
        <span>{part.year ?? t("collection.soon")}</span>
        {part.episodes !== null && part.episodes > 1 && <span>{tn("common.episodes", part.episodes)}</span>}
      </div>
    </button>
  );
}

export function AnimeOrder({ names, type, year }: { names: string[]; type: "movie" | "tv"; year: number | null }) {
  const { t } = useT();
  const loaded = useAsync(() => animeInfo({ names, type, year }), [names.join("|"), type, year]);
  const info = loaded.data;
  // An extra: without an answer, or with nothing to put in order, the page is complete as it is.
  if (!info || info.parts.length < minParts) return null;
  return (
    <Row title={t("anime.order.title")}>
      {info.parts.map((part) => (
        <AnimeCard key={part.id} part={part} current={part.id === info.current.id} />
      ))}
    </Row>
  );
}
