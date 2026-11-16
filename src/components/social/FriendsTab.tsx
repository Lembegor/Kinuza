import { useNavigate } from "react-router-dom";
import { Check, Cloud, CloudAlert, LoaderCircle, LogOut, RefreshCw, Trash2, UserMinus, UserPlus, X } from "lucide-react";
import { accountApi } from "../../lib/accountApi";
import { describeError } from "../../lib/backend";
import { useT } from "../../lib/i18n";
import { useAccount } from "../../state/account";
import { useUi } from "../../state/ui";
import { CopyInvite, useAddFriend } from "./AddFriendDialog";
import { titlePathOf } from "./FriendsButton";
import { FriendRow, GoogleMark, PersonAvatar } from "./SocialBits";

function syncText(t: ReturnType<typeof useT>["t"], locale: string, state: string, at: number | null, error: string | null): string {
  if (state === "syncing") return t("account.sync.running");
  if (state === "error") return t("account.sync.failed", { reason: describeError(error ?? "") });
  if (!at) return t("account.sync.never");
  const minutes = Math.round((Date.now() - at) / 60000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const ago = minutes < 1 ? t("account.sync.justNow") : minutes < 60 ? format.format(-minutes, "minute") : format.format(-Math.round(minutes / 60), "hour");
  return t("account.sync.done", { ago });
}

function AccountCard() {
  const { t, locale } = useT();
  const { phase, account, sync, signIn, signOut, deleteAccount, update, syncNow } = useAccount();
  const askConfirm = useUi((state) => state.askConfirm);

  if (phase !== "signedIn" || !account) {
    return (
      <section className="profile-card account-card account-card--pitch">
        <span className="account-card__icon">
          <Cloud size={26} />
        </span>
        <div className="account-card__pitch">
          <h2>{t("account.pitch.title")}</h2>
          <p>{t("account.pitch.text")}</p>
          <ul>
            <li>{t("account.pitch.backup")}</li>
            <li>{t("account.pitch.friends")}</li>
            <li>{t("account.pitch.status")}</li>
          </ul>
          <button className="button button--primary google-button" disabled={phase === "signingIn"} onClick={() => void signIn()}>
            <GoogleMark />
            {t("account.signIn")}
          </button>
          <small>{t("account.pitch.local")}</small>
          <small>{t("account.pitch.privacy")}</small>
        </div>
      </section>
    );
  }

  const SyncIcon = sync.state === "error" ? CloudAlert : sync.state === "syncing" ? LoaderCircle : Check;
  return (
    <section className="profile-card account-card">
      <div className="account-card__head">
        <PersonAvatar name={account.name} avatar={account.avatar} size={52} />
        <div>
          <b>{account.name || t("profile.defaultName")}</b>
          <small>{account.email}</small>
        </div>
      </div>
      <div className={`account-card__sync is-${sync.state}`}>
        <SyncIcon size={16} className={sync.state === "syncing" ? "spin" : ""} />
        <span>{syncText(t, locale, sync.state, sync.at, sync.error)}</span>
        <button className="button button--small" disabled={sync.state === "syncing"} onClick={() => void syncNow()}>
          <RefreshCw size={14} />
          {t("account.sync.now")}
        </button>
      </div>
      <div className="account-card__privacy">
        <label className="check">
          <input type="checkbox" checked={account.showActivity} onChange={(event) => void update({ showActivity: event.target.checked })} />
          <span>
            {t("account.privacy.activity")}
            <small>{t("account.privacy.activityNote")}</small>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={account.invisible} onChange={(event) => void update({ invisible: event.target.checked })} />
          <span>
            {t("account.privacy.invisible")}
            <small>{t("account.privacy.invisibleNote")}</small>
          </span>
        </label>
      </div>
      <div className="account-card__actions">
        <button className="button button--small" onClick={() => void signOut(false)}>
          <LogOut size={14} />
          {t("account.signOut")}
        </button>
        <button
          className="button button--small"
          onClick={() =>
            askConfirm({
              title: t("account.signOutAll.title"),
              message: t("account.signOutAll.text"),
              confirmLabel: t("account.signOutAll.confirm"),
              onConfirm: () => void signOut(true),
            })
          }
        >
          {t("account.signOutAll.button")}
        </button>
        <button
          className="button button--small button--danger-text"
          onClick={() =>
            askConfirm({
              title: t("account.delete.title"),
              message: t("account.delete.text"),
              confirmLabel: t("account.delete.confirm"),
              danger: true,
              onConfirm: () => void deleteAccount(),
            })
          }
        >
          <Trash2 size={14} />
          {t("account.delete.button")}
        </button>
      </div>
    </section>
  );
}

function FriendsCard() {
  const { t } = useT();
  const navigate = useNavigate();
  const { phase, account, social, applySocial } = useAccount();
  const showAdd = useAddFriend((state) => state.show);
  const askConfirm = useUi((state) => state.askConfirm);
  if (phase !== "signedIn" || !account) return null;

  const act = async (action: () => Promise<Parameters<typeof applySocial>[0]>) => {
    try {
      applySocial(await action());
    } catch (error) {
      useUi.getState().toast(describeError(error), "error");
    }
  };
  const friends = social?.friends ?? [];
  const incoming = social?.incoming ?? [];
  const outgoing = social?.outgoing ?? [];

  return (
    <section className="profile-card friends-card">
      <div className="profile-card__head">
        <h2>{t("friends.title")}</h2>
        <button className="button button--small button--primary" onClick={() => showAdd()}>
          <UserPlus size={14} />
          {t("friends.add.title")}
        </button>
      </div>
      {account.code && <CopyInvite code={account.code} />}
      {incoming.length > 0 && (
        <div className="friends-card__group">
          <h3>{t("friends.requests.incoming")}</h3>
          {incoming.map((person) => (
            <div key={person.id} className="friend-row">
              <span className="friend-row__main">
                <PersonAvatar name={person.name} avatar={person.avatar} />
                <span className="friend-row__text">
                  <b>{person.name || t("friends.someone")}</b>
                  <small>{t("friends.requests.wants")}</small>
                </span>
              </span>
              <button className="button button--small button--primary" onClick={() => void act(() => accountApi.accept(person.id))}>
                <Check size={14} />
                {t("friends.requests.accept")}
              </button>
              <button className="icon-button" aria-label={t("friends.requests.decline")} title={t("friends.requests.decline")} onClick={() => void act(() => accountApi.decline(person.id))}>
                <X size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      {outgoing.length > 0 && (
        <div className="friends-card__group">
          <h3>{t("friends.requests.outgoing")}</h3>
          {outgoing.map((person) => (
            <div key={person.id} className="friend-row">
              <span className="friend-row__main">
                <PersonAvatar name={person.name} avatar={person.avatar} />
                <span className="friend-row__text">
                  <b>{person.name || t("friends.someone")}</b>
                  <small>{t("friends.requests.pending")}</small>
                </span>
              </span>
              <button className="button button--small" onClick={() => void act(() => accountApi.cancel(person.id))}>
                {t("friends.requests.cancel")}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="friends-card__group">
        {friends.length === 0 ? (
          <p className="friends-card__empty">{t("friends.emptyLong")}</p>
        ) : (
          friends.map((friend) => {
            const path = titlePathOf(friend);
            return (
              <FriendRow key={friend.id} friend={friend} onOpen={path ? () => navigate(path) : undefined}>
                <button
                  className="icon-button friend-row__remove"
                  aria-label={t("friends.remove.button")}
                  title={t("friends.remove.button")}
                  onClick={() =>
                    askConfirm({
                      title: t("friends.remove.title", { name: friend.name || t("friends.someone") }),
                      message: t("friends.remove.text"),
                      confirmLabel: t("friends.remove.button"),
                      danger: true,
                      onConfirm: () => void act(() => accountApi.removeFriend(friend.id)),
                    })
                  }
                >
                  <UserMinus size={16} />
                </button>
              </FriendRow>
            );
          })
        )}
      </div>
    </section>
  );
}

export function FriendsTab() {
  return (
    <div className="friends-tab">
      <AccountCard />
      <FriendsCard />
    </div>
  );
}
