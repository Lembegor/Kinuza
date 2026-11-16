import { useEffect, useState } from "react";
import { LogOut, MessagesSquare, Play, SmilePlus, Undo2, Users } from "lucide-react";
import { useT } from "../../lib/i18n";
import { chatParts, partyReactions, type PartyReaction } from "../../lib/party";
import { canControl, clock, describeMedia, memberName, returnToRoom, sendControl, sendReaction, sendSkip, useParty } from "../../state/party";
import { PersonAvatar } from "../social/SocialBits";

export const reactionGlyphs: Record<PartyReaction, string> = { laugh: "😂", wow: "😮", scary: "😱", sad: "😢", fire: "🔥", heart: "❤️" };
const bubbleMs = 6000;
const skipOfferMs = 8000;

function useTicker(active: boolean, every = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [active, every]);
  return now;
}

function ringOf(member: { online: boolean; skipped: boolean; status: { away?: boolean; waiting?: boolean; synced?: boolean; loaded?: boolean } }): string {
  if (!member.online) return "is-offline";
  if (member.status.away) return "is-away";
  if (member.skipped) return "is-behind";
  if (member.status.waiting || !member.status.loaded) return "is-loading";
  return "is-synced";
}

export function PartyControlButton() {
  const { t } = useT();
  const phase = useParty((state) => state.phase);
  const unread = useParty((state) => state.unread);
  const open = useParty((state) => state.panelOpen);
  const setPanel = useParty((state) => state.setPanel);
  if (phase === "idle" || phase === "connecting") return null;
  return (
    <button className={`player__button ${open ? "is-on" : ""}`} aria-label={t("party.title")} title={t("party.title")} data-menu-toggle onClick={() => setPanel(!open)}>
      <Users size={19} />
      {unread > 0 && <span className="party-badge">{unread > 9 ? "9+" : unread}</span>}
    </button>
  );
}

function ReactionBar() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className={`party-react ${open ? "is-open" : ""}`}>
      {open &&
        partyReactions.map((reaction, index) => (
          <button
            key={reaction}
            className="party-react__item"
            title={`${t(`party.reaction.${reaction}`)} (${index + 1})`}
            onClick={() => {
              sendReaction(reaction);
              setOpen(false);
            }}
          >
            {reactionGlyphs[reaction]}
          </button>
        ))}
      <button className="party-react__toggle" aria-label={t("party.reactions")} title={t("party.reactions")} onClick={() => setOpen((value) => !value)}>
        <SmilePlus size={18} />
      </button>
    </div>
  );
}

function ChatBubbles() {
  const chat = useParty((state) => state.chat);
  const me = useParty((state) => state.me);
  const panelOpen = useParty((state) => state.panelOpen);
  const setPanel = useParty((state) => state.setPanel);
  useTicker(!panelOpen, 1000);
  if (panelOpen) return null;
  const serverNow = clock.serverNow();
  const fresh = chat.filter((item) => item.kind === "text" && item.from !== me && serverNow - item.at < bubbleMs / 1000).slice(-3);
  if (fresh.length === 0) return null;
  return (
    <div className="party-bubbles">
      {fresh.map((item) => (
        <button key={item.id} className="party-bubble" onClick={() => setPanel(true, "chat")}>
          <b>{memberName(item.from)}</b>
          <span>
            {chatParts(item.text ?? "").map((part, index) =>
              part.spoiler ? (
                <span key={index} className="party-spoiler">
                  {part.text}
                </span>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

function WaitCard() {
  const { t } = useT();
  const state = useParty((s) => s.state);
  const members = useParty((s) => s.members);
  const me = useParty((s) => s.me);
  const now = useTicker(!!state?.gate || (!!state?.playing && state.countdown), 200);
  if (!state) return null;
  const serverNow = clock.serverNow();
  if (state.playing && state.countdown && serverNow < state.at) {
    const left = Math.max(1, Math.ceil(state.at - serverNow));
    return (
      <div className="party-countdown" key={left}>
        {left}
      </div>
    );
  }
  const gate = state.gate;
  if (!gate) return null;
  const others = gate.waiting.filter((id) => id !== me);
  const waitingForMe = gate.waiting.includes(me);
  if (gate.waiting.length === 0) return null;
  const waited = serverNow - gate.since;
  if (waited < 0.6 && !gate.resume) return null;
  const slow = others.map((id) => members.find((member) => member.id === id)).filter((member) => member !== undefined);
  return (
    <div className="party-wait" data-now={now}>
      {waitingForMe && others.length === 0 ? (
        <b>{t("party.wait.loading")}</b>
      ) : (
        <>
          <div className="party-wait__people">
            {slow.slice(0, 4).map((member) => (
              <span key={member.id} className="party-wait__person">
                <PersonAvatar name={member.name} avatar={member.avatar} size={28} />
                <i style={{ width: `${member.status.pct ?? 0}%` }} />
              </span>
            ))}
          </div>
          <b>{slow.length === 1 ? t("party.wait.one", { name: slow[0].name || t("friends.someone") }) : t("party.wait.many", { count: slow.length })}</b>
          {slow.length === 1 && <small>{t("party.wait.percent", { percent: slow[0].status.pct ?? 0 })}</small>}
          {canControl() && waited * 1000 > skipOfferMs && (
            <div className="party-wait__actions">
              {slow.map((member) => (
                <button key={member.id} className="button button--small" onClick={() => sendSkip(member.id)}>
                  {t("party.wait.skip", { name: member.name || t("friends.someone") })}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Lobby() {
  const { t } = useT();
  const state = useParty((s) => s.state);
  const members = useParty((s) => s.members);
  const host = useParty((s) => s.host);
  if (!state || state.playing || state.gate || (state.reason !== "" && state.reason !== "media")) return null;
  const present = members.filter((member) => member.online && !member.status.away);
  const ready = present.filter((member) => member.status.loaded && !member.status.waiting);
  return (
    <div className="party-lobby">
      <div className="party-lobby__people">
        {present.slice(0, 6).map((member) => (
          <span key={member.id} className={`party-lobby__person ${member.status.loaded && !member.status.waiting ? "is-ready" : ""}`} title={member.name}>
            <PersonAvatar name={member.name} avatar={member.avatar} size={36} />
            <i style={{ width: `${member.status.loaded ? 100 : (member.status.pct ?? 0)}%` }} />
          </span>
        ))}
      </div>
      <small>{t("party.lobby.ready", { ready: ready.length, total: present.length })}</small>
      {canControl() ? (
        <button className="button button--primary button--large" onClick={() => sendControl("play")}>
          <Play size={18} fill="currentColor" />
          {t("party.lobby.start")}
        </button>
      ) : (
        <b>{t("party.lobby.waitHost", { name: memberName(host) })}</b>
      )}
      <small className="party-lobby__hint">{t("party.lobby.hint")}</small>
    </div>
  );
}

function Notices() {
  const { t } = useT();
  const notices = useParty((state) => state.notices);
  return (
    <div className="party-notices">
      {notices.map((item) => (
        <div key={item.id} className="party-notice">
          <span>{item.text}</span>
          {item.undo !== undefined && canControl() && (
            <button className="party-notice__undo" onClick={() => sendControl("seek", item.undo)}>
              <Undo2 size={14} />
              {t("party.notice.undo")}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Bursts() {
  const bursts = useParty((state) => state.bursts);
  const members = useParty((state) => state.members);
  return (
    <div className="party-bursts">
      {bursts.map((burst, index) => {
        const member = members.find((item) => item.id === burst.from);
        return (
          <span key={burst.id} className="party-burst" style={{ right: `${8 + ((index * 37) % 90)}px` }}>
            <span className="party-burst__glyph">{reactionGlyphs[burst.e]}</span>
            {member && <PersonAvatar name={member.name} avatar={member.avatar} size={20} />}
          </span>
        );
      })}
    </div>
  );
}

function Avatars() {
  const members = useParty((state) => state.members);
  return (
    <div className="party-avatars">
      {members.slice(0, 6).map((member) => (
        <span key={member.id} className={`party-avatars__item ${ringOf(member)}`} title={member.name}>
          <PersonAvatar name={member.name} avatar={member.avatar} size={26} />
        </span>
      ))}
    </div>
  );
}

export function PartyPlayerOverlay({ active, foreign }: { active: boolean; foreign: boolean }) {
  const { t } = useT();
  const media = useParty((state) => state.media);
  const leave = useParty((state) => state.leave);
  if (foreign && media) {
    return (
      <div className="party-foreign">
        <MessagesSquare size={16} />
        <span>{t("party.foreign", { title: describeMedia(media) })}</span>
        <button className="button button--small button--primary" onClick={returnToRoom}>
          {t("party.foreign.back")}
        </button>
        <button className="button button--small" onClick={leave}>
          <LogOut size={14} />
          {t("party.leave")}
        </button>
      </div>
    );
  }
  if (!active) return null;
  return (
    <div className="party-layer">
      <Avatars />
      <Notices />
      <Lobby />
      <WaitCard />
      <Bursts />
      <ChatBubbles />
      <ReactionBar />
    </div>
  );
}
