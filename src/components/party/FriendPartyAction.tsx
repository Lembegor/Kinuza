import { useState } from "react";
import { Check, DoorOpen, Popcorn } from "lucide-react";
import type { Friend } from "../../lib/accountApi";
import { useT } from "../../lib/i18n";
import { inviteFriend, useParty } from "../../state/party";

export function FriendPartyAction({ friend }: { friend: Friend }) {
  const { t } = useT();
  const phase = useParty((state) => state.phase);
  const code = useParty((state) => state.code);
  const members = useParty((state) => state.members);
  const [sent, setSent] = useState(false);
  const inRoom = phase === "live" || phase === "reconnecting";
  if (friend.room && friend.room.code !== code) {
    return (
      <button className="button button--small" title={friend.room.title ?? undefined} onClick={() => void useParty.getState().join(friend.room!.code)}>
        <DoorOpen size={14} />
        {t("party.friend.join")}
      </button>
    );
  }
  if (!inRoom || members.some((member) => member.id === friend.id)) return null;
  return (
    <button
      className={`button button--small ${sent ? "is-done" : ""}`}
      disabled={sent}
      onClick={() => {
        inviteFriend(friend.id);
        setSent(true);
      }}
    >
      {sent ? <Check size={14} /> : <Popcorn size={14} />}
      {sent ? t("party.invite.sent") : t("party.invite.call")}
    </button>
  );
}
