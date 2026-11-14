import { useEffect, useRef, useState } from "react";
import { Ban, Check, ChevronDown, Clock, Eye, Heart, ListPlus, Pause, Star, Trash2, X, type LucideIcon } from "lucide-react";
import { t, useT, type MessageKey } from "../lib/i18n";
import { maxRating, statusLabel, titleKey, useLibrary, watchStatuses, type TitleRef, type WatchStatus } from "../state/library";
import { useUi } from "../state/ui";
import { applyStatus } from "../state/titleStatus";

export function removeTrackedWithUndo(key: string): void {
  const { tracked, removeTracked, restoreTracked } = useLibrary.getState();
  const entry = tracked[key];
  if (!entry) return;
  removeTracked(key);
  useUi.getState().toast(t("library.removed", { title: entry.title }), "info", {
    label: t("feed.dismissed.undo"),
    run: () => restoreTracked(key, entry),
  });
}

export const statusIcons: Record<WatchStatus, LucideIcon> = {
  watching: Eye,
  planned: Clock,
  completed: Check,
  onHold: Pause,
  dropped: Ban,
};

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

export function StatusMenu({ title }: { title: TitleRef }) {
  const key = titleKey(title.type, title.id);
  const entry = useLibrary((state) => state.tracked[key]);
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  const status = entry?.status ?? null;
  const Icon = status ? statusIcons[status] : ListPlus;

  return (
    <div className="status-menu" ref={ref}>
      <button className={`button button--large ${status ? `status-button status-button--${status}` : ""}`} onClick={() => setOpen(!open)}>
        <Icon size={18} />
        {status ? statusLabel(status) : t("library.add")}
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="popover">
          {watchStatuses.map((item) => {
            const ItemIcon = statusIcons[item.id];
            return (
              <button
                key={item.id}
                className={`popover__item ${item.id === status ? "is-active" : ""}`}
                onClick={() => {
                  applyStatus(title, item.id);
                  setOpen(false);
                }}
              >
                <ItemIcon size={16} />
                <span>{t(item.labelKey)}</span>
                {item.id === status && <Check size={15} />}
              </button>
            );
          })}
          {entry && (
            <button
              className="popover__item popover__item--danger"
              onClick={() => {
                removeTrackedWithUndo(key);
                setOpen(false);
              }}
            >
              <Trash2 size={16} />
              <span>{t("library.remove")}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const ratingBurstMs = 700;

export function RatingStars({ title }: { title: TitleRef }) {
  const rating = useLibrary((state) => state.tracked[titleKey(title.type, title.id)]?.rating ?? null);
  const setRating = useLibrary((state) => state.setRating);
  const { t } = useT();
  const [hover, setHover] = useState<number | null>(null);
  const [burst, setBurst] = useState(false);
  const burstTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(burstTimer.current), []);
  const shown = hover ?? rating ?? 0;

  const choose = (value: number | null) => {
    setRating(title, value);
    clearTimeout(burstTimer.current);
    setBurst(value !== null);
    if (value !== null) burstTimer.current = setTimeout(() => setBurst(false), ratingBurstMs);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (rating ?? 0) + step;
    choose(next < 1 ? null : Math.min(maxRating, next));
  };

  return (
    <div className={`rating-stars ${rating !== null ? "is-rated" : ""} ${hover !== null ? "is-picking" : ""}`} onMouseLeave={() => setHover(null)} onKeyDown={onKeyDown}>
      <span className="rating-stars__label">{t("library.rating.mine")}</span>
      <div className={`rating-stars__row ${burst ? "is-burst" : ""}`}>
        {Array.from({ length: maxRating }, (_, index) => {
          const value = index + 1;
          return (
            <button
              key={value}
              aria-label={t("library.rating.value", { value })}
              aria-pressed={value === rating}
              className={`${value <= shown ? "is-on" : ""} ${value === hover ? "is-aim" : ""}`}
              style={{ "--i": index } as React.CSSProperties}
              onMouseEnter={() => setHover(value)}
              onFocus={() => setHover(value)}
              onBlur={() => setHover(null)}
              onClick={() => choose(value === rating ? null : value)}
            >
              <Star size={22} fill={value <= shown ? "currentColor" : "none"} strokeWidth={value <= shown ? 0 : 1.6} />
            </button>
          );
        })}
      </div>
      <span className="rating-stars__value">
        {shown > 0 ? (
          <>
            <b key={shown}>{shown}</b>
            <i>/{maxRating}</i>
            <em>{t(`library.rating.word.${shown}` as MessageKey)}</em>
          </>
        ) : (
          <em>{t("library.rating.none")}</em>
        )}
      </span>
      <button
        className="rating-stars__clear"
        aria-label={t("library.rating.clear")}
        title={t("library.rating.clear")}
        disabled={rating === null}
        onClick={() => {
          setHover(null);
          choose(null);
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function TrackBadge({ type, id }: Pick<TitleRef, "type" | "id">) {
  const entry = useLibrary((state) => state.tracked[titleKey(type, id)]);
  const { t } = useT();
  if (!entry || (!entry.status && !entry.rating && !entry.liked)) return null;
  const Icon = entry.status ? statusIcons[entry.status] : null;
  const label = entry.status ? statusLabel(entry.status) : entry.rating ? t("library.rating.mine") : t("library.liked");
  return (
    <span className={`track-badge ${entry.status ? `track-badge--${entry.status}` : ""}`} title={label}>
      {Icon && <Icon size={12} />}
      {entry.rating ? (
        <>
          <Star size={10} fill="currentColor" />
          {entry.rating}
        </>
      ) : (
        entry.liked && <Heart size={11} fill="currentColor" />
      )}
    </span>
  );
}
