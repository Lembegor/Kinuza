import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Clock, EyeOff, LoaderCircle, RefreshCw, UserX } from "lucide-react";
import { FriendPartyAction } from "../components/party/FriendPartyAction";
import { Medal } from "../components/achievements/Medal";
import { tierNames } from "../lib/achievements";
import { achievementById } from "../state/achievements";
import { noteOf } from "../components/profile/ProfileHistory";
import { titlePathOf } from "../components/social/FriendsButton";
import { PersonAvatar } from "../components/social/SocialBits";
import { accountApi, type Friend } from "../lib/accountApi";
import { describeError } from "../lib/backend";
import { readFriendCard, type FriendCard } from "../lib/friendCard";
import { formatSeconds } from "../lib/profileFormat";
import type { HistoryItem, Overview } from "../lib/profileStats";
import { imageUrl } from "../lib/tmdb";
import { useT } from "../lib/i18n";
import { friendStatus, useAccount } from "../state/account";
import { Counters, Details, Genres, Habits, Heatmap, MonthChart, Ratings, SidePoster, TimeCard, shortDay, titlePath } from "./Profile";

interface Loaded {
  friend: Friend;
  hidden: boolean;
  card: FriendCard | null;
  overview: Overview | null;
}

function FriendAchievements({ card }: { card: FriendCard }) {
  const { t } = useT();
  const items = (card.achievements ?? []).flatMap((item) => {
    const def = achievementById(item.id);
    return def ? [{ def, tier: Math.min(item.tier, def.tiers.length) }] : [];
  });
  if (items.length === 0) return null;
  return (
    <section className="profile-card side-card">
      <div className="profile-card__head">
        <h2>{t("achievements.friend")}</h2>
      </div>
      <div className="friend-achievements">
        {items.map(({ def, tier }) => (
          <div key={def.id} className="friend-achievements__item">
            <Medal def={def} tier={tier} size={44} />
            <span>
              <b>{t(`achievements.${def.id}.name` as never)}</b>
              <small>{def.tiers.length === 1 ? t("achievements.tier.single") : t(`achievements.tier.${tierNames[tier - 1]}`)}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function FriendSide({ card }: { card: FriendCard }) {
  const { t, tn, locale } = useT();
  return (
    <aside className="profile-side">
      <FriendAchievements card={card} />
      {card.watching.length > 0 && (
        <section className="profile-card side-card">
          <div className="profile-card__head">
            <h2>{t("profile.side.watching")}</h2>
          </div>
          <ul className="side-list">
            {card.watching.map((item) => (
              <li key={item.key}>
                <Link className="side-item" to={titlePath(item.key)}>
                  <SidePoster path={item.poster} />
                  <span className="side-item__text">
                    <b>{item.name}</b>
                    <small>
                      {item.movie
                        ? item.share > 0
                          ? t("profile.side.percent", { value: Math.round(item.share * 100) })
                          : t("profile.kind.movie")
                        : item.total > 0
                          ? t("profile.side.episodeOf", { watched: item.watched, total: item.total })
                          : tn("common.episodes", item.watched)}
                    </small>
                    {item.share > 0 && (
                      <span className="side-item__meter">
                        <i className="is-accent" style={{ width: `${item.share * 100}%` }} />
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {card.top.length > 0 && (
        <section className="profile-card side-card">
          <div className="profile-card__head">
            <h2>{t("profile.side.top")}</h2>
          </div>
          <ul className="side-list">
            {card.top.map((item) => (
              <li key={item.key}>
                <Link className="side-item" to={titlePath(item.key)}>
                  <SidePoster path={item.poster} />
                  <span className="side-item__text">
                    <b>{item.name}</b>
                    <small>{formatSeconds(item.seconds)}</small>
                    <span className="side-item__meter">
                      <i className={`kind-${item.kind}`} style={{ width: `${(item.seconds / card.top[0].seconds) * 100}%` }} />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {card.recent.length > 0 && (
        <section className="profile-card side-card">
          <div className="profile-card__head">
            <h2>{t("profile.side.recent")}</h2>
          </div>
          <ul className="side-list">
            {card.recent.map((item) => (
              <li key={item.id}>
                <Link className="side-item" to={titlePath(item.key)}>
                  <SidePoster path={item.poster} />
                  <span className="side-item__text">
                    <b>{item.name}</b>
                    <small>
                      {item.at ? `${shortDay(item.at, locale, t)} · ` : ""}
                      {noteOf({ ...item, eventIds: [] } as HistoryItem, t, tn)}
                    </small>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

function FriendNote({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <section className="profile-empty friend-profile__note">
      {icon}
      <h2>{title}</h2>
      <p>{text}</p>
    </section>
  );
}

export default function FriendProfile() {
  const { t, tn, locale } = useT();
  const navigate = useNavigate();
  const { id } = useParams();
  const friendId = Number(id);
  const phase = useAccount((state) => state.phase);
  const listed = useAccount((state) => state.social?.friends.find((friend) => friend.id === friendId) ?? null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const now = useMemo(() => Date.now(), []);

  const load = useCallback(async () => {
    if (!Number.isFinite(friendId) || phase !== "signedIn") return;
    setBusy(true);
    setProblem("");
    try {
      const answer = await accountApi.friendCard(friendId);
      const read = answer.card ? readFriendCard(answer.card) : null;
      setLoaded({ friend: answer.friend, hidden: answer.hidden, card: read?.card ?? null, overview: read?.overview ?? null });
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  }, [friendId, phase]);

  useEffect(() => {
    setLoaded(null);
    void load();
  }, [load]);

  const friend = listed ?? loaded?.friend ?? null;
  const card = loaded?.card ?? null;
  const data = loaded?.overview ?? null;
  const watchingPath = friend ? titlePathOf(friend) : null;
  const sinceText = card?.since ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(new Date(card.since)) : null;

  if (phase === "signedOut") {
    return (
      <div className="page profile friend-profile">
        <FriendNote icon={<UserX size={34} />} title={t("friendProfile.signIn.title")} text={t("friendProfile.signIn.text")} />
      </div>
    );
  }

  return (
    <div className="page profile friend-profile">
      <header className="profile-head">
        {card?.cover && <img className="profile-head__cover" src={imageUrl(card.cover, "w1280") ?? undefined} alt="" draggable={false} />}
        <div className="profile-head__shade" />
        <button className="icon-button friend-profile__back" aria-label={t("common.back")} onClick={() => navigate(-1)}>
          <ArrowLeft size={18} />
        </button>
        <span className="profile-head__avatar">
          <PersonAvatar name={friend?.name ?? ""} avatar={friend?.avatar ?? null} size={76} online={friend?.online} />
        </span>
        <div className="profile-head__text">
          <h1>{friend?.name || (busy ? "…" : t("friends.someone"))}</h1>
          <p>
            {friend && (
              <span>
                {watchingPath ? <Link to={watchingPath}>{friendStatus(friend, locale)}</Link> : friendStatus(friend, locale)}
              </span>
            )}
            {sinceText && <span>{t("profile.since", { date: sinceText })}</span>}
            {card && card.titles > 0 && <span>{tn("profile.titles", card.titles)}</span>}
          </p>
        </div>
        {friend && <FriendPartyAction friend={friend} />}
      </header>

      {problem ? (
        <section className="profile-card friend-profile__problem">
          <p>{problem}</p>
          <button className="button button--small" onClick={() => void load()}>
            <RefreshCw size={14} />
            {t("friendProfile.retry")}
          </button>
        </section>
      ) : !loaded ? (
        <div className="profile-skeleton">
          {busy && <LoaderCircle size={22} className="spin" />}
          <div className="profile-card" />
          <div className="profile-card" />
        </div>
      ) : loaded.hidden ? (
        <FriendNote icon={<EyeOff size={34} />} title={t("friendProfile.hidden.title")} text={t("friendProfile.hidden.text")} />
      ) : !card || !data ? (
        <FriendNote icon={<UserX size={34} />} title={t("friendProfile.empty.title")} text={t("friendProfile.empty.text")} />
      ) : data.seconds === 0 && data.movies === 0 && data.episodes === 0 && data.rating.count === 0 ? (
        <FriendNote icon={<Clock size={34} />} title={t("friendProfile.nothing.title")} text={t("friendProfile.nothing.text")} />
      ) : (
        <div className="profile-layout">
          <div className="profile-main">
            <TimeCard data={data} kind={null} />
            <Counters data={data} period="all" friendSeries={card.completedSeries} />
            <Heatmap data={data} now={now} readOnly />
            <div className="profile-grid">
              <MonthChart data={data} />
              <Ratings data={data} friend />
              <Genres data={data} />
              <Habits data={data} friend />
            </div>
            <Details data={data} />
          </div>
          <FriendSide card={card} />
        </div>
      )}
    </div>
  );
}
