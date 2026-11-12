import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { animeInfo, type AnimeFormat, type AnimePart } from "../lib/anilist";
import { useT, type MessageKey } from "../lib/i18n";
import { shikimoriNames } from "../lib/localized";
import { useAsync } from "../lib/useAsync";
import { Row } from "./Cards";

const minParts = 2;

const formatLabels: Record<AnimeFormat, MessageKey> = {
  TV: "anime.format.tv",
  TV_SHORT: "anime.format.tv",
  MOVIE: "anime.format.movie",
  OVA: "anime.format.ova",
  ONA: "anime.format.ona",
  SPECIAL: "anime.format.special",
};

function AnimeCard({ part, current, localName }: { part: AnimePart; current: boolean; localName: string | null }) {
  const { t, tn } = useT();
  const navigate = useNavigate();
  const cardRef = useRef<HTMLButtonElement>(null);
  const searchName = part.english || part.romaji;
  const name = localName || searchName;

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
      onClick={() => navigate(`/search?q=${encodeURIComponent(searchName)}`)}
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
  const { t, language } = useT();
  const loaded = useAsync(() => animeInfo({ names, type, year }), [names.join("|"), type, year]);
  const info = loaded.data;
  const malIds = language === "ru" && info ? info.parts.map((part) => part.malId).filter((id): id is number => id !== null) : [];
  const localNames = useAsync(() => shikimoriNames(malIds).catch(() => new Map<number, string>()), [malIds.join(",")]);
  if (!info || info.parts.length < minParts) return null;
  return (
    <Row title={t("anime.order.title")}>
      {info.parts.map((part) => (
        <AnimeCard key={part.id} part={part} current={part.id === info.current.id} localName={(part.malId !== null && localNames.data?.get(part.malId)) || null} />
      ))}
    </Row>
  );
}
