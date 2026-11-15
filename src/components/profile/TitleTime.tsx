import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Clock } from "lucide-react";
import { useT } from "../../lib/i18n";
import { titleTotals } from "../../lib/profileStats";
import { formatSeconds } from "../../lib/profileFormat";
import type { TitleRef } from "../../state/library";
import { useLedger } from "../../state/stats";

export function TitleTime({ title }: { title: TitleRef }) {
  const { t, tn } = useT();
  const { ledger } = useLedger();
  const key = `${title.type}:${title.id}`;
  const totals = useMemo(() => (ledger ? titleTotals(ledger, key) : null), [ledger, key]);
  if (!totals || totals.seconds < 60) return null;
  const parts = [t("profile.titleTime.spent", { time: `${totals.estimated ? "≈ " : ""}${formatSeconds(totals.seconds)}` })];
  if (title.type === "tv" && totals.episodes > 0) parts.push(tn("common.episodes", totals.episodes));
  if (totals.rewatches > 0) parts.push(tn("profile.titleTime.rewatches", totals.rewatches));
  return (
    <Link className="title-time" to={`/profile/history?title=${key}`} title={t("profile.titleTime.open")}>
      <Clock size={14} />
      {parts.join(" · ")}
    </Link>
  );
}
