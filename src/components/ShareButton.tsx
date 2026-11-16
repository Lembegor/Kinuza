import { useEffect, useState } from "react";
import { Check, Share2 } from "lucide-react";
import { useT } from "../lib/i18n";
import { shareLink } from "../lib/share";
import type { MediaType } from "../lib/tmdb";
import { useUi } from "../state/ui";

const doneShownMs = 2500;

export function ShareButton({ type, id, name }: { type: MediaType; id: number; name: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), doneShownMs);
    return () => clearTimeout(timer);
  }, [copied]);

  const share = async () => {
    const { toast } = useUi.getState();
    try {
      await navigator.clipboard.writeText(shareLink(type, id));
      setCopied(true);
      toast(t(type === "movie" ? "share.copied.movie" : "share.copied.series", { name }), "success");
    } catch {
      toast(t("share.failed"), "error");
    }
  };

  return (
    <button className={`button button--large share-button ${copied ? "is-done" : ""}`} onClick={() => void share()} title={t("share.hint")}>
      {copied ? <Check size={18} /> : <Share2 size={18} />}
      {copied ? t("share.done") : t("share.button")}
    </button>
  );
}
