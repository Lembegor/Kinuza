import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { QuickActions, Row, type CardItem } from "../Cards";
import { PersonAvatar } from "../social/SocialBits";
import { useCardTitle } from "../../lib/catalog";
import { t, useT } from "../../lib/i18n";
import { imageUrl } from "../../lib/tmdb";
import type { FriendMark, FriendsItem } from "../../state/friendsFeed";

const shownFaces = 3;

function markText(mark: FriendMark): string {
  const name = mark.friend.name || t("friends.someone");
  switch (mark.kind) {
    case "live":
      return t("home.friends.live", { name });
    case "rated":
      return t("home.friends.rated", { name, rating: mark.rating ?? 0 });
    case "finished":
      return t("home.friends.finished", { name });
    case "watched":
      return mark.season !== null && mark.episode !== null
        ? t("home.friends.episode", { name, episode: t("title.episodeShort", { season: mark.season, episode: mark.episode }) })
        : t("home.friends.watched", { name });
    default:
      return mark.total > 0 ? t("home.friends.progress", { name, watched: mark.watched, total: mark.total }) : t("home.friends.watched", { name });
  }
}

function pathOf(item: FriendsItem): string {
  const live = item.marks.find((mark) => mark.kind === "live" && mark.season !== null);
  const query = item.type === "tv" && live ? `?s=${live.season}${live.episode !== null ? `&e=${live.episode}` : ""}` : "";
  return `/title/${item.type}/${item.id}${query}`;
}

function FriendsCard({ item }: { item: FriendsItem }) {
  const navigate = useNavigate();
  const title = useCardTitle(item.type, item.id, item.title);
  const poster = imageUrl(item.poster, "w342");
  const [first, ...rest] = item.marks;
  const names = item.marks.map((mark) => mark.friend.name).join(", ");
  const card: CardItem = { type: item.type, id: item.id, title, poster: item.poster, backdrop: null, year: "" };
  return (
    <div className={`poster-card friends-card ${item.live ? "is-live" : ""}`}>
      <button className="poster-card__open" onClick={() => navigate(pathOf(item))}>
        <div className="poster-card__art">
          {poster ? <img src={poster} alt="" loading="lazy" draggable={false} /> : <div className="poster-card__blank">{title}</div>}
          {item.live && <span className="friends-card__live">{t("home.friends.now")}</span>}
          <span className="friends-card__faces" title={names}>
            {item.marks.slice(0, shownFaces).map((mark) => (
              <PersonAvatar key={mark.friend.id} name={mark.friend.name} avatar={mark.friend.avatar} size={28} />
            ))}
            {item.marks.length > shownFaces && <span className="friends-card__more">+{item.marks.length - shownFaces}</span>}
          </span>
        </div>
        <div className="poster-card__title">{title}</div>
        <div className="poster-card__meta">
          <span className={first.kind === "live" ? "is-accent" : undefined}>
            {markText(first)}
            {rest.length > 0 && <span className="friends-card__others"> {t("home.friends.more", { count: rest.length })}</span>}
          </span>
        </div>
      </button>
      <QuickActions item={card} />
    </div>
  );
}

export function FriendsRow({ items, menu }: { items: FriendsItem[]; menu?: ReactNode }) {
  const { t } = useT();
  const navigate = useNavigate();
  if (items.length === 0) return null;
  return (
    <Row
      title={t("home.row.friends")}
      aside={<span className="row__sub">{t("home.friends.sub")}</span>}
      more={{ label: t("home.friends.all"), onClick: () => navigate("/profile/friends") }}
      menu={menu}
      className="friends-row"
    >
      {items.map((item) => (
        <FriendsCard key={item.key} item={item} />
      ))}
    </Row>
  );
}
