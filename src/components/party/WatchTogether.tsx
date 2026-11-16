import { Lightbulb, LoaderCircle, Users } from "lucide-react";
import { useT } from "../../lib/i18n";
import type { TitleRef } from "../../state/library";
import { sendChat, useParty, whenLive } from "../../state/party";
import { useUi } from "../../state/ui";

export function WatchTogetherButton({ title, canPlay, onPlay }: { title: TitleRef; canPlay: boolean; onPlay: () => void }) {
  const { t } = useT();
  const phase = useParty((state) => state.phase);
  const host = useParty((state) => state.host);
  const me = useParty((state) => state.me);
  const inRoom = phase === "live" || phase === "reconnecting";

  if (inRoom && host !== me) {
    return (
      <button
        className="button button--large"
        onClick={() => {
          sendChat("", { type: title.type, id: title.id, title: title.title, ...(title.poster ? { poster: title.poster } : {}), ...(title.year ? { year: title.year } : {}) });
          useUi.getState().toast(t("party.suggest.sent"), "success");
        }}
      >
        <Lightbulb size={18} />
        {t("party.suggest.button")}
      </button>
    );
  }
  if (inRoom) {
    if (!canPlay) return null;
    return (
      <button className="button button--large" onClick={onPlay}>
        <Users size={18} />
        {t("party.playForAll")}
      </button>
    );
  }
  return (
    <button
      className="button button--large"
      disabled={phase === "connecting"}
      onClick={async () => {
        await useParty.getState().create();
        if (canPlay && (await whenLive())) onPlay();
      }}
    >
      {phase === "connecting" ? <LoaderCircle size={18} className="spin" /> : <Users size={18} />}
      {t("party.watchTogether")}
    </button>
  );
}
