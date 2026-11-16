import { Cast } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useCast, type CastJob } from "../../state/cast";
import { useParty } from "../../state/party";
import { useUi } from "../../state/ui";

export function CastButton({ build }: { build: () => CastJob | null }) {
  const { t } = useT();
  const inRoom = useParty((state) => state.phase === "live" || state.phase === "reconnecting");
  return (
    <button
      className="player__button"
      aria-label={t("cast.button")}
      title={inRoom ? t("cast.inRoom") : t("cast.button")}
      data-menu-toggle
      onClick={() => {
        if (inRoom) {
          useUi.getState().toast(t("cast.inRoom"), "info");
          return;
        }
        const job = build();
        if (job) useCast.getState().pick(job);
      }}
    >
      <Cast size={19} />
    </button>
  );
}
