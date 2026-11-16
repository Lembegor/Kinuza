import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Cloud, UserPlus, Users } from "lucide-react";
import type { Friend } from "../../lib/accountApi";
import { useT } from "../../lib/i18n";
import { useAccount } from "../../state/account";
import { useAddFriend } from "./AddFriendDialog";
import { FriendRow, GoogleMark } from "./SocialBits";

const shownFriends = 12;

export function titlePathOf(friend: Friend): string | null {
  const watching = friend.watching;
  if (!watching) return null;
  const query = watching.type === "tv" && watching.season !== undefined ? `?s=${watching.season}${watching.episode !== undefined ? `&e=${watching.episode}` : ""}` : "";
  return `/title/${watching.type}/${watching.id}${query}`;
}

export function FriendsButton() {
  const { t } = useT();
  const navigate = useNavigate();
  const phase = useAccount((state) => state.phase);
  const social = useAccount((state) => state.social);
  const signIn = useAccount((state) => state.signIn);
  const refresh = useAccount((state) => state.refreshSocial);
  const showAdd = useAddFriend((state) => state.show);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    if (phase === "signedIn") void refresh();
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === "unknown") return null;
  const friends = social?.friends ?? [];
  const online = friends.filter((friend) => friend.online).length;
  const requests = social?.incoming.length ?? 0;
  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <div className="friends-button" ref={rootRef}>
      <button
        className={`inbox__button ${requests > 0 ? "has-unread" : ""}`}
        aria-label={t("friends.title")}
        title={t("friends.title")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Users size={17} />
        {requests > 0 ? <span className="inbox__badge">{requests > 9 ? "9+" : requests}</span> : online > 0 && <span className="friends-button__online">{online}</span>}
      </button>
      {open && (
        <div className="inbox__panel friends-panel" role="dialog" aria-label={t("friends.title")}>
          {phase !== "signedIn" ? (
            <div className="friends-panel__pitch">
              <span className="friends-panel__icon">
                <Cloud size={22} />
              </span>
              <h3>{t("account.pitch.title")}</h3>
              <ul>
                <li>{t("account.pitch.backup")}</li>
                <li>{t("account.pitch.friends")}</li>
                <li>{t("account.pitch.status")}</li>
              </ul>
              <button className="button button--primary button--block google-button" disabled={phase === "signingIn"} onClick={() => void signIn()}>
                <GoogleMark />
                {t("account.signIn")}
              </button>
              <small>{t("account.pitch.noPassword")}</small>
              <small>{t("account.pitch.local")}</small>
            </div>
          ) : (
            <>
              <div className="inbox__head">
                <b>{t("friends.title")}</b>
                <button
                  className="icon-button"
                  aria-label={t("friends.add.title")}
                  title={t("friends.add.title")}
                  onClick={() => {
                    setOpen(false);
                    showAdd();
                  }}
                >
                  <UserPlus size={16} />
                </button>
              </div>
              {requests > 0 && (
                <button className="friends-panel__requests" onClick={() => go("/profile/friends")}>
                  {t("friends.requests.waiting", { count: requests })}
                </button>
              )}
              {friends.length === 0 ? (
                <div className="friends-panel__empty">
                  <p>{t("friends.empty")}</p>
                  <button
                    className="button button--small"
                    onClick={() => {
                      setOpen(false);
                      showAdd();
                    }}
                  >
                    <UserPlus size={14} />
                    {t("friends.add.title")}
                  </button>
                </div>
              ) : (
                <div className="friends-panel__list">
                  {friends.slice(0, shownFriends).map((friend) => {
                    const path = titlePathOf(friend);
                    return <FriendRow key={friend.id} friend={friend} onOpen={path ? () => go(path) : undefined} />;
                  })}
                </div>
              )}
              <button className="friends-panel__all" onClick={() => go("/profile/friends")}>
                {t("friends.all")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
