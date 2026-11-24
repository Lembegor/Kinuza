import { useId } from "react";
import {
  CalendarDays,
  Clock,
  Coffee,
  FastForward,
  Film,
  Flame,
  Ghost,
  Gift,
  Globe,
  Hourglass,
  Landmark,
  Languages,
  ListVideo,
  Moon,
  Mountain,
  Music,
  Palette,
  PartyPopper,
  Popcorn,
  Repeat,
  Sparkles,
  Star,
  Ticket,
  Timer,
  Trophy,
  Tv,
  Users,
  Zap,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";
import { tierNames, type AchievementDef, type AchievementIcon } from "../../lib/achievements";

const icons: Record<AchievementIcon, LucideIcon> = {
  clock: Clock,
  film: Film,
  tv: Tv,
  list: ListVideo,
  sparkles: Sparkles,
  flame: Flame,
  star: Star,
  palette: Palette,
  globe: Globe,
  languages: Languages,
  users: Users,
  popcorn: Popcorn,
  zap: Zap,
  calendar: CalendarDays,
  ticket: Ticket,
  moon: Moon,
  coffee: Coffee,
  hourglass: Hourglass,
  landmark: Landmark,
  timer: Timer,
  mountain: Mountain,
  trophy: Trophy,
  party: PartyPopper,
  repeat: Repeat,
  gift: Gift,
  ghost: Ghost,
  music: Music,
  forward: FastForward,
};

export function tierClass(def: AchievementDef, tier: number): string {
  if (tier <= 0) return "is-locked";
  if (def.tiers.length === 1) return def.secret ? "is-secret" : "is-gold";
  return `is-${tierNames[Math.min(tier, tierNames.length) - 1]}`;
}

export function Medal({
  def,
  tier,
  size = 64,
  progress,
  hidden = false,
  className = "",
}: {
  def: AchievementDef;
  tier: number;
  size?: number;
  progress?: number;
  hidden?: boolean;
  className?: string;
}) {
  const id = useId().replace(/:/g, "");
  const Icon = hidden ? HelpCircle : icons[def.icon];
  const locked = tier <= 0;
  const ring = 2 * Math.PI * 47;
  const share = Math.max(0, Math.min(1, progress ?? 0));
  return (
    <span className={`medal ${tierClass(def, tier)} ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg className="medal__art" viewBox="0 0 100 100">
        <defs>
          <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: "var(--m1)" }} />
            <stop offset="0.5" style={{ stopColor: "var(--m2)" }} />
            <stop offset="1" style={{ stopColor: "var(--m3)" }} />
          </linearGradient>
          <radialGradient id={`${id}-face`} cx="0.5" cy="0.32" r="0.75">
            <stop offset="0" style={{ stopColor: "var(--face1)" }} />
            <stop offset="1" style={{ stopColor: "var(--face2)" }} />
          </radialGradient>
        </defs>
        {locked && progress !== undefined && (
          <>
            <circle className="medal__track" cx="50" cy="50" r="47" />
            <circle className="medal__progress" cx="50" cy="50" r="47" strokeDasharray={`${ring * share} ${ring}`} transform="rotate(-90 50 50)" />
          </>
        )}
        <circle cx="50" cy="50" r="42" fill={`url(#${id}-rim)`} />
        <circle cx="50" cy="50" r="42" className="medal__notches" />
        <circle cx="50" cy="50" r="33" fill={`url(#${id}-face)`} />
        <circle cx="50" cy="50" r="33" className="medal__inner" />
        <path d="M22 38 A30 30 0 0 1 78 38" className="medal__gloss" />
      </svg>
      <Icon className="medal__icon" size={Math.round(size * 0.34)} strokeWidth={2.1} />
    </span>
  );
}

export function TierPips({ def, tier }: { def: AchievementDef; tier: number }) {
  if (def.tiers.length === 1) return null;
  return (
    <span className="tier-pips" aria-hidden="true">
      {def.tiers.map((_, index) => (
        <i key={index} className={index < tier ? `is-on is-${tierNames[index]}` : ""} />
      ))}
    </span>
  );
}
