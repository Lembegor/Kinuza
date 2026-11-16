import { useMemo, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { PosterRow, Row, useShownOnce, type CardItem, type DismissDetail } from "../Cards";
import { CatalogRating } from "../CatalogRating";
import { currentLocale, t, useT } from "../../lib/i18n";
import { imageUrl } from "../../lib/tmdb";
import type { FeedItem, FeedRow } from "../../state/feed";
import type { PlannedItem, PlannedReason } from "../../state/homeFeed";
import { noteOpened, type ShownItem } from "../../state/impressions";
import type { TitleRef } from "../../state/library";

const plannedLimit = 18;

function reasonText(reason: PlannedReason, locale: string): string {
  switch (reason.kind) {
    case "season":
      return t("home.planned.season", { season: reason.season });
    case "premiere":
      return t("home.planned.premiere");
    case "episode":
      return t("home.planned.episode");
    case "digital":
      return t("home.planned.digital");
    default: {
      const date = new Date(reason.at);
      const sameYear = date.getFullYear() === new Date().getFullYear();
      return t("home.planned.added", { date: date.toLocaleDateString(locale, sameYear ? { day: "numeric", month: "long" } : { month: "long", year: "numeric" }) });
    }
  }
}

export function PlannedRow({ items, total, menu }: { items: PlannedItem[]; total: number; menu?: ReactNode }) {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const cards = useMemo<CardItem[]>(
    () => items.slice(0, plannedLimit).map((item) => ({ ...item, note: reasonText(item.reason, locale), noteAccent: item.fresh })),
    [items, locale],
  );
  if (cards.length === 0) return null;
  return (
    <PosterRow
      title={t("home.row.planned")}
      aside={<span className="row__sub">{t("home.planned.sub")}</span>}
      items={cards}
      more={{ label: t("home.planned.all", { count: total }), onClick: () => navigate("/library?status=planned") }}
      menu={menu}
    />
  );
}

function GemCard({ item, rowId }: { item: FeedItem; rowId: string }) {
  const navigate = useNavigate();
  const slotRef = useRef<HTMLDivElement>(null);
  useShownOnce(slotRef, item, rowId);
  const art = imageUrl(item.backdrop, "w780") ?? imageUrl(item.poster, "w342");
  const open = () => {
    noteOpened(item as ShownItem, rowId);
    navigate(`/title/${item.type}/${item.id}`);
  };
  return (
    <div className="gem-slot" ref={slotRef}>
      <button className="gem-card" onClick={open}>
        <span className="gem-card__art">{art && <img src={art} alt="" loading="lazy" draggable={false} />}</span>
        <span className="gem-card__body">
          <span className="gem-card__title">{item.title}</span>
          <span className="gem-card__meta">
            <CatalogRating type={item.type} id={item.id} rating={item.rating} className="rating" size={11} />
            {item.year && <span>{item.year}</span>}
            {item.voteCount > 0 && <span>{t("home.daily.votes", { count: item.voteCount.toLocaleString(currentLocale()) })}</span>}
          </span>
          {item.note && <span className="gem-card__why">{item.note}</span>}
        </span>
      </button>
    </div>
  );
}

export function DailyPick({ row, onDismiss, menu }: { row: FeedRow; onDismiss: (item: TitleRef, detail: DismissDetail) => void; menu?: ReactNode }) {
  const { t } = useT();
  const aside = <span className="row__sub">{row.id === "gems" ? t("home.daily.gemsSub") : t("home.daily.sub")}</span>;
  if (row.id === "gems" && row.items.some((item) => item.backdrop)) {
    return (
      <Row title={row.title} aside={aside} menu={menu} className="home-gems">
        {row.items.map((item) => (
          <GemCard key={`${item.type}:${item.id}`} item={item} rowId={row.id} />
        ))}
      </Row>
    );
  }
  return <PosterRow title={row.title} aside={aside} items={row.items} onDismiss={onDismiss} rowId={row.id} menu={menu} />;
}
