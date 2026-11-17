import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  Check,
  Clapperboard,
  Copy,
  Crown,
  DoorOpen,
  Ellipsis,
  LoaderCircle,
  LogIn,
  LogOut,
  Play,
  RefreshCw,
  Send,
  Settings2,
  UserPlus,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { useT } from "../../lib/i18n";
import { chatParts, cleanRoomCode, formatClock, formatRoomCode, partyChatLimit, roomLink, type PartyMember, type PartyMessage } from "../../lib/party";
import { imageUrl } from "../../lib/tmdb";
import { isTopDialog, useDialogFocus } from "../../lib/useDialogFocus";
import { useAccount } from "../../state/account";
import {
  copyTracks,
  describeMedia,
  inviteFriend,
  kickMember,
  makeHost,
  memberName,
  rejoinLast,
  returnToRoom,
  sendChat,
  sendSettings,
  sendTyping,
  unitOf,
  useParty,
} from "../../state/party";
import { useUi } from "../../state/ui";
import { GoogleMark, PersonAvatar } from "../social/SocialBits";

const copiedMs = 2000;
const typingGapMs = 2500;
const lastLeftMs = 2 * 60_000;

function memberLine(t: ReturnType<typeof useT>["t"], member: PartyMember): string {
  if (!member.online) return t("party.status.offline");
  const status = member.status;
  if (status.away) return t("party.status.away");
  if (member.skipped) return t("party.status.catching");
  if (!status.loaded) return status.pct !== undefined ? t("party.status.loading", { percent: status.pct }) : t("party.status.opening");
  if (status.waiting) return t("party.status.loading", { percent: status.pct ?? 0 });
  if (status.drift !== undefined && Math.abs(status.drift) >= 2) return t("party.status.behind", { seconds: Math.round(Math.abs(status.drift)) });
  return t("party.status.synced");
}

function tracksLine(t: ReturnType<typeof useT>["t"], member: PartyMember): string {
  const audio = member.status.audio?.label;
  const sub = member.status.sub;
  const subText = !sub || sub.kind === "none" ? t("party.tracks.noSubs") : sub.label || t("common.subtitles");
  return [audio, subText].filter(Boolean).join(" · ");
}

function useCopied(): [string | null, (what: string, text: string) => void] {
  const { t } = useT();
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), copiedMs);
    return () => clearTimeout(timer);
  }, [copied]);
  return [
    copied,
    (what, text) => {
      void navigator.clipboard
        .writeText(text)
        .then(() => setCopied(what))
        .catch(() => useUi.getState().toast(t("share.failed"), "error"));
    },
  ];
}

export function RoomButton() {
  const { t } = useT();
  const phase = useParty((state) => state.phase);
  const members = useParty((state) => state.members);
  const unread = useParty((state) => state.unread);
  const panelOpen = useParty((state) => state.panelOpen);
  const lastLeft = useParty((state) => state.lastLeft);
  const account = useAccount((state) => state.phase);
  const [menu, setMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  if (account === "unknown") return null;
  const inRoom = phase === "live" || phase === "reconnecting";
  if (inRoom) {
    return (
      <div className="room-button">
        <button className={`inbox__button room-button__live ${panelOpen ? "is-open" : ""}`} aria-label={t("party.title")} title={t("party.title")} onClick={() => useParty.getState().setPanel(!panelOpen)}>
          {phase === "reconnecting" ? <WifiOff size={16} /> : <Users size={16} />}
          <span className="room-button__faces">
            {members.slice(0, 3).map((member) => (
              <PersonAvatar key={member.id} name={member.name} avatar={member.avatar} size={18} />
            ))}
          </span>
          {unread > 0 && <span className="inbox__badge">{unread > 9 ? "9+" : unread}</span>}
        </button>
      </div>
    );
  }
  const recent = lastLeft && Date.now() - lastLeft.at < lastLeftMs;
  return (
    <div className="room-button" ref={rootRef}>
      <button className="inbox__button" aria-label={t("party.watchTogether")} title={t("party.watchTogether")} disabled={phase === "connecting"} onClick={() => setMenu((value) => !value)}>
        {phase === "connecting" ? <LoaderCircle size={17} className="spin" /> : <Clapperboard size={17} />}
      </button>
      {menu && (
        <div className="inbox__panel room-menu" role="menu">
          <b className="room-menu__title">{t("party.watchTogether")}</b>
          <p className="room-menu__text">{t("party.menu.text")}</p>
          <button
            className="button button--primary button--block"
            onClick={() => {
              setMenu(false);
              void useParty.getState().create();
            }}
          >
            <Users size={16} />
            {t("party.create")}
          </button>
          <button
            className="button button--block"
            onClick={() => {
              setMenu(false);
              useParty.getState().showJoin(true);
            }}
          >
            <LogIn size={16} />
            {t("party.joinByCode")}
          </button>
          {recent && (
            <button
              className="button button--block"
              onClick={() => {
                setMenu(false);
                rejoinLast();
              }}
            >
              <DoorOpen size={16} />
              {t("party.rejoin")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ChatLine({ item, me, onSuggest }: { item: PartyMessage; me: number; onSuggest: (item: PartyMessage) => void }) {
  const { t } = useT();
  const members = useParty((state) => state.members);
  const [shown, setShown] = useState<Set<number>>(new Set());
  if (item.kind !== "text") {
    const name = item.name || memberName(item.target ?? item.from);
    const text =
      item.kind === "joined"
        ? t("party.chat.joined", { name })
        : item.kind === "left"
          ? t("party.chat.left", { name })
          : item.kind === "kicked"
            ? t("party.chat.kicked", { name })
            : item.kind === "host"
              ? t("party.chat.host", { name })
              : item.kind === "skipped"
                ? t("party.chat.skipped", { name })
                : t("party.chat.media", { title: item.title ?? "" });
    return <p className="room-chat__system">{text}</p>;
  }
  const member = members.find((person) => person.id === item.from);
  const mine = item.from === me;
  return (
    <div className={`room-chat__message ${mine ? "is-mine" : ""}`}>
      <PersonAvatar name={member?.name ?? "?"} avatar={member?.avatar ?? null} size={26} />
      <div className="room-chat__body">
        <div className="room-chat__head">
          <b>{member?.name || t("friends.someone")}</b>
          <small>
            {new Date(item.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {t("party.chat.at", { time: formatClock(item.pos) })}
          </small>
        </div>
        <p>
          {chatParts(item.text ?? "").map((part, index) =>
            part.spoiler ? (
              <button
                key={index}
                className={`party-spoiler ${shown.has(index) ? "is-shown" : ""}`}
                onClick={() => setShown((value) => new Set(value).add(index))}
              >
                {part.text}
              </button>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )}
        </p>
        {item.suggest && (
          <button className="room-chat__suggest" onClick={() => onSuggest(item)}>
            {item.suggest.poster && <img src={imageUrl(item.suggest.poster, "w185") ?? ""} alt="" draggable={false} />}
            <span>
              <b>{item.suggest.title}</b>
              <small>{t("party.suggest.open")}</small>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function ChatTab() {
  const { t } = useT();
  const navigate = useNavigate();
  const chat = useParty((state) => state.chat);
  const me = useParty((state) => state.me);
  const typing = useParty((state) => state.typing);
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [chat.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const typers = Object.keys(typing)
    .map(Number)
    .filter((id) => id !== me)
    .map((id) => memberName(id));

  const submit = () => {
    if (!text.trim()) return;
    sendChat(text);
    setText("");
  };

  return (
    <div className="room-chat">
      <div className="room-chat__list" ref={listRef}>
        {chat.length === 0 && <p className="room-chat__empty">{t("party.chat.empty")}</p>}
        {chat.map((item) => (
          <ChatLine key={`${item.id}:${item.at}`} item={item} me={me} onSuggest={(found) => found.suggest && navigate(`/title/${found.suggest.type}/${found.suggest.id}`)} />
        ))}
      </div>
      <div className="room-chat__typing">{typers.length > 0 ? t("party.chat.typing", { names: typers.join(", ") }) : ""}</div>
      <div className="room-chat__input">
        <textarea
          ref={inputRef}
          className="input"
          rows={1}
          value={text}
          maxLength={partyChatLimit}
          placeholder={t("party.chat.placeholder")}
          onChange={(event) => {
            setText(event.target.value);
            if (Date.now() - lastTyping.current > typingGapMs) {
              lastTyping.current = Date.now();
              sendTyping();
            }
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              inputRef.current?.blur();
            }
          }}
        />
        <button className="icon-button" aria-label={t("party.chat.send")} title={t("party.chat.send")} disabled={!text.trim()} onClick={submit}>
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}

function PersonMenu({ member }: { member: PartyMember }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const askConfirm = useUi((state) => state.askConfirm);
  return (
    <div className="room-person__menu">
      <button className="icon-button" aria-label={t("party.person.more")} onClick={() => setOpen((value) => !value)}>
        <Ellipsis size={16} />
      </button>
      {open && (
        <div className="room-person__popup" onMouseLeave={() => setOpen(false)}>
          <button
            onClick={() => {
              setOpen(false);
              makeHost(member.id);
            }}
          >
            <Crown size={14} />
            {t("party.person.makeHost")}
          </button>
          <button
            className="is-danger"
            onClick={() => {
              setOpen(false);
              askConfirm({
                title: t("party.person.kickTitle", { name: member.name || t("friends.someone") }),
                message: t("party.person.kickText"),
                confirmLabel: t("party.person.kick"),
                danger: true,
                onConfirm: () => kickMember(member.id),
              });
            }}
          >
            <X size={14} />
            {t("party.person.kick")}
          </button>
        </div>
      )}
    </div>
  );
}

function PeopleTab() {
  const { t } = useT();
  const members = useParty((state) => state.members);
  const me = useParty((state) => state.me);
  const host = useParty((state) => state.host);
  return (
    <div className="room-people">
      {members.map((member) => (
        <div key={member.id} className={`room-person ${member.online ? "" : "is-offline"}`}>
          <span className={`room-person__avatar party-ring ${!member.online ? "is-offline" : member.status.away ? "is-away" : member.status.waiting || !member.status.loaded ? "is-loading" : member.skipped ? "is-behind" : "is-synced"}`}>
            <PersonAvatar name={member.name} avatar={member.avatar} size={34} />
          </span>
          <span className="room-person__text">
            <b>
              {member.name || t("friends.someone")}
              {member.id === me && <em>{t("party.person.you")}</em>}
              {member.id === host && <Crown size={13} className="room-person__crown" />}
            </b>
            <small>{memberLine(t, member)}</small>
            {member.status.loaded && <small className="room-person__tracks">{tracksLine(t, member)}</small>}
            {member.status.has && <small className="room-person__seeding">{t("party.person.seeding")}</small>}
          </span>
          {member.id !== me && member.status.loaded && (
            <button className="button button--small" title={t("party.person.sameHint")} onClick={() => copyTracks(member.id)}>
              {t("party.person.same")}
            </button>
          )}
          {host === me && member.id !== me && <PersonMenu member={member} />}
        </div>
      ))}
    </div>
  );
}

function SettingsBlock() {
  const { t } = useT();
  const settings = useParty((state) => state.settings);
  const host = useParty((state) => state.host);
  const me = useParty((state) => state.me);
  const lag = useParty((state) => state.lag);
  const setLag = useParty((state) => state.setLag);
  const mine = host === me;
  return (
    <div className="room-settings">
      {mine && (
        <>
          <label className="check">
            <input type="checkbox" checked={settings.control === "host"} onChange={(event) => sendSettings({ control: event.target.checked ? "host" : "all" })} />
            <span>
              {t("party.settings.hostOnly")}
              <small>{t("party.settings.hostOnlyNote")}</small>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.wait} onChange={(event) => sendSettings({ wait: event.target.checked })} />
            <span>
              {t("party.settings.wait")}
              <small>{t("party.settings.waitNote")}</small>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.friends} onChange={(event) => sendSettings({ friends: event.target.checked })} />
            <span>
              {t("party.settings.friends")}
              <small>{t("party.settings.friendsNote")}</small>
            </span>
          </label>
        </>
      )}
      <label className="room-settings__lag">
        <span>
          {t("party.settings.lag", { value: (lag * 1000).toFixed(0) })}
          <small>{t("party.settings.lagNote")}</small>
        </span>
        <input type="range" min={0} max={0.5} step={0.05} value={lag} onChange={(event) => setLag(Number(event.target.value))} />
      </label>
    </div>
  );
}

function MediaCard() {
  const { t } = useT();
  const media = useParty((state) => state.media);
  const preparing = useParty((state) => state.preparing);
  const prepareError = useParty((state) => state.prepareError);
  const host = useParty((state) => state.host);
  const me = useParty((state) => state.me);
  const player = useUi((s) => s.player);
  if (!media) {
    return <div className="room-media room-media--empty">{host === me ? t("party.media.pickHost") : t("party.media.pickWait", { name: memberName(host) })}</div>;
  }
  const watching = player && player.unitKey === unitOf(media);
  const poster = media.poster ? imageUrl(media.poster, "w185") : null;
  return (
    <div className="room-media">
      {poster && <img className="room-media__poster" src={poster} alt="" draggable={false} />}
      <div className="room-media__text">
        <b>{describeMedia(media)}</b>
        <small>{[media.quality, media.size ? `${(media.size / 1024 ** 3).toFixed(1)} GB` : ""].filter(Boolean).join(" · ")}</small>
        {preparing && (
          <small className="room-media__busy">
            <LoaderCircle size={13} className="spin" />
            {t("party.media.preparing")}
          </small>
        )}
        {prepareError && (
          <small className="room-media__error">
            {prepareError}
            <button className="link-button" onClick={returnToRoom}>
              <RefreshCw size={12} />
              {t("common.retry")}
            </button>
          </small>
        )}
        {!preparing && !prepareError && !watching && (
          <button className="button button--small" onClick={returnToRoom}>
            <Play size={14} />
            {t("party.media.back")}
          </button>
        )}
      </div>
    </div>
  );
}

export function RoomPanel() {
  const { t } = useT();
  const phase = useParty((state) => state.phase);
  const open = useParty((state) => state.panelOpen);
  const tab = useParty((state) => state.tab);
  const code = useParty((state) => state.code);
  const members = useParty((state) => state.members);
  const unread = useParty((state) => state.unread);
  const setPanel = useParty((state) => state.setPanel);
  const leave = useParty((state) => state.leave);
  const askConfirm = useUi((state) => state.askConfirm);
  const [settingsShown, setSettingsShown] = useState(false);
  const [copied, copy] = useCopied();
  if ((phase !== "live" && phase !== "reconnecting") || !open || !code) return null;
  return createPortal(
    <aside className="room-panel" aria-label={t("party.title")}>
      <div className="room-panel__head">
        <div className="room-panel__title">
          <b>{t("party.title")}</b>
          <button className="room-panel__code" title={t("party.copyLink")} onClick={() => copy("link", roomLink(code))}>
            {formatRoomCode(code)}
            {copied === "link" ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
        <button className="icon-button" aria-label={t("party.invite.title")} title={t("party.invite.title")} onClick={() => useParty.getState().showInvite(true)}>
          <UserPlus size={17} />
        </button>
        <button className={`icon-button ${settingsShown ? "is-on" : ""}`} aria-label={t("party.settings.title")} title={t("party.settings.title")} onClick={() => setSettingsShown((value) => !value)}>
          <Settings2 size={17} />
        </button>
        <button
          className="icon-button"
          aria-label={t("party.leave")}
          title={t("party.leave")}
          onClick={() =>
            askConfirm({ title: t("party.leaveTitle"), message: t("party.leaveText"), confirmLabel: t("party.leave"), onConfirm: () => leave() })
          }
        >
          <LogOut size={17} />
        </button>
        <button className="icon-button" aria-label={t("common.close")} onClick={() => setPanel(false)}>
          <X size={17} />
        </button>
      </div>
      {phase === "reconnecting" && (
        <div className="room-panel__offline">
          <WifiOff size={14} />
          {t("party.reconnecting")}
        </div>
      )}
      {settingsShown && <SettingsBlock />}
      <MediaCard />
      <div className="room-panel__tabs" role="tablist">
        <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "is-active" : ""} onClick={() => setPanel(true, "chat")}>
          {t("party.tab.chat")}
          {unread > 0 && tab !== "chat" && <span className="inbox__badge">{unread}</span>}
        </button>
        <button role="tab" aria-selected={tab === "people"} className={tab === "people" ? "is-active" : ""} onClick={() => setPanel(true, "people")}>
          {t("party.tab.people", { count: members.length })}
        </button>
      </div>
      {tab === "chat" ? <ChatTab /> : <PeopleTab />}
    </aside>,
    document.body,
  );
}

function useEscape(open: boolean, dialogRef: React.RefObject<HTMLDivElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isTopDialog(dialogRef)) {
        event.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close, dialogRef]);
}

export function JoinRoomDialog() {
  const { t } = useT();
  const open = useParty((state) => state.joinOpen);
  const preset = useParty((state) => state.joinCode);
  const showJoin = useParty((state) => state.showJoin);
  const phase = useParty((state) => state.phase);
  const account = useAccount((state) => state.phase);
  const signIn = useAccount((state) => state.signIn);
  const [code, setCode] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = () => showJoin(false);
  useDialogFocus(dialogRef, open);
  useEscape(open, dialogRef, close);
  useEffect(() => {
    if (open) setCode(cleanRoomCode(preset));
  }, [open, preset]);
  if (!open) return null;
  const join = () => {
    if (code.length !== 6) return;
    close();
    void useParty.getState().join(code);
  };
  return createPortal(
    <div className="backdrop backdrop--top" onMouseDown={close}>
      <div ref={dialogRef} className="dialog dialog--small add-friend" role="dialog" aria-modal="true" aria-labelledby="join-room-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <h2 id="join-room-title">{t("party.joinByCode")}</h2>
          <button className="icon-button" aria-label={t("common.close")} onClick={close}>
            <X size={18} />
          </button>
        </div>
        {account !== "signedIn" ? (
          <div className="add-friend__signin">
            <p className="dialog__text">{t("party.needAccount")}</p>
            <button className="button button--primary button--block google-button" onClick={() => void signIn()}>
              <GoogleMark />
              {t("account.signIn")}
            </button>
          </div>
        ) : (
          <>
            <p className="dialog__text">{t("party.join.text")}</p>
            <input
              className="input add-friend__input"
              data-autofocus
              value={formatRoomCode(code)}
              placeholder="XXX-XXX"
              maxLength={7}
              spellCheck={false}
              onChange={(event) => setCode(cleanRoomCode(event.target.value))}
              onPaste={(event) => {
                event.preventDefault();
                setCode(cleanRoomCode(event.clipboardData.getData("text")));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") join();
              }}
            />
            <div className="dialog__actions">
              <button className="button button--primary" disabled={code.length !== 6 || phase === "connecting"} onClick={join}>
                <LogIn size={16} />
                {t("party.join.button")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function InviteDialog() {
  const { t } = useT();
  const open = useParty((state) => state.inviteOpen);
  const showInvite = useParty((state) => state.showInvite);
  const code = useParty((state) => state.code);
  const members = useParty((state) => state.members);
  const social = useAccount((state) => state.social);
  const refresh = useAccount((state) => state.refreshSocial);
  const [sent, setSent] = useState<Set<number>>(new Set());
  const [copied, copy] = useCopied();
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = () => showInvite(false);
  useDialogFocus(dialogRef, open);
  useEscape(open, dialogRef, close);
  useEffect(() => {
    if (!open) return;
    setSent(new Set());
    void refresh();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open || !code) return null;
  const inside = new Set(members.map((member) => member.id));
  const friends = [...(social?.friends ?? [])].filter((friend) => !inside.has(friend.id)).sort((a, b) => Number(b.online) - Number(a.online));
  return createPortal(
    <div className="backdrop backdrop--top" onMouseDown={close}>
      <div ref={dialogRef} className="dialog dialog--small room-invite" role="dialog" aria-modal="true" aria-labelledby="room-invite-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <h2 id="room-invite-title">{t("party.invite.title")}</h2>
          <button className="icon-button" aria-label={t("common.close")} onClick={close}>
            <X size={18} />
          </button>
        </div>
        <div className="room-invite__code">
          <span>{t("party.invite.code")}</span>
          <button className="room-invite__value" onClick={() => copy("code", formatRoomCode(code))}>
            {formatRoomCode(code)}
            {copied === "code" ? <Check size={16} /> : <Copy size={16} />}
          </button>
          <button className={`button button--small ${copied === "link" ? "is-done" : ""}`} onClick={() => copy("link", roomLink(code))}>
            {copied === "link" ? <Check size={14} /> : <Copy size={14} />}
            {copied === "link" ? t("share.done") : t("party.copyLink")}
          </button>
        </div>
        <div className="room-invite__friends">
          {friends.length === 0 ? (
            <p className="dialog__text">{t("party.invite.noFriends")}</p>
          ) : (
            friends.map((friend) => (
              <div key={friend.id} className="room-invite__friend">
                <PersonAvatar name={friend.name} avatar={friend.avatar} online={friend.online} size={32} />
                <span className="room-invite__who">
                  <b>{friend.name || t("friends.someone")}</b>
                  <small>{friend.online ? t("friends.status.online") : t("friends.status.offline")}</small>
                </span>
                <button
                  className={`button button--small ${sent.has(friend.id) ? "is-done" : "button--primary"}`}
                  disabled={sent.has(friend.id)}
                  onClick={() => {
                    inviteFriend(friend.id);
                    setSent((value) => new Set(value).add(friend.id));
                  }}
                >
                  {sent.has(friend.id) ? <Check size={14} /> : <UserPlus size={14} />}
                  {sent.has(friend.id) ? t("party.invite.sent") : t("party.invite.call")}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
