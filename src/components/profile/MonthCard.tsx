import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { monthKey, overview } from "../../lib/profileStats";
import { formatSeconds, monthNameStandalone } from "../../lib/profileFormat";
import { useProfile } from "../../state/profile";
import { useLedger } from "../../state/stats";
import { useSettings } from "../../state/settings";

const firstDays = 7;
const leastSeconds = 3600;
const decemberIndex = 11;

function cardOf(now: number): { id: string; from: number; to: number; month: string | null; year: number } | null {
  const date = new Date(now);
  if (date.getMonth() === decemberIndex) {
    return { id: `year:${date.getFullYear()}`, from: new Date(date.getFullYear(), 0, 1).getTime(), to: now, month: null, year: date.getFullYear() };
  }
  if (date.getDate() > firstDays) return null;
  const from = new Date(date.getFullYear(), date.getMonth() - 1, 1).getTime();
  const to = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  return { id: `month:${monthKey(from)}`, from, to, month: monthKey(from), year: new Date(from).getFullYear() };
}

function Card({ card }: { card: NonNullable<ReturnType<typeof cardOf>> }) {
  const { t, tn } = useT();
  const navigate = useNavigate();
  const { ledger } = useLedger();
  const data = useMemo(() => (ledger ? overview(ledger, { from: card.from, to: card.to }, null, card.to - 1) : null), [ledger, card]);
  if (!data || data.seconds < leastSeconds) return null;
  const favourite = data.top[0]?.name;
  const facts = [formatSeconds(data.seconds), tn("profile.count.movies", data.movies), tn("common.episodes", data.episodes)];
  if (favourite) facts.push(t("profile.card.favourite", { title: favourite }));
  const title = card.month ? t("profile.card.month", { month: monthNameStandalone(card.month) }) : t("profile.card.year", { year: card.year });
  const open = () => navigate(card.month ? "/profile" : `/profile/year?y=${card.year}`);
  return (
    <section className="month-card">
      <div className="month-card__text">
        <h2>{title}</h2>
        <p>{facts.join(" · ")}</p>
      </div>
      <button className="button" onClick={open}>
        {card.month ? t("profile.card.open") : t("profile.card.openYear")}
      </button>
      <button className="icon-button month-card__close" aria-label={t("profile.card.hide")} title={t("profile.card.hide")} onClick={() => useProfile.getState().dismissCard(card.id)}>
        <X size={16} />
      </button>
    </section>
  );
}

export function MonthCard() {
  const dismissed = useProfile((state) => state.dismissedCards);
  const loaded = useProfile((state) => state.loaded);
  useSettings((state) => state.language);
  const card = useMemo(() => cardOf(Date.now()), []);
  if (!loaded || !card || dismissed.includes(card.id)) return null;
  return <Card card={card} />;
}
