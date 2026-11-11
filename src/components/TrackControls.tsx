// Controls for the user's list: watch status menu and the personal rating.

import { useEffect, useRef, useState } from "react";
import { Ban, Check, ChevronDown, Clock, Eye, ListPlus, Pause, Star, Trash2, type LucideIcon } from "lucide-react";
import { maxRating, statusLabel, titleKey, useLibrary, watchStatuses, type TitleRef, type WatchStatus } from "../state/library";

export const statusIcons: Record<WatchStatus, LucideIcon> = {
  watching: Eye,
  planned: Clock,
  completed: Check,
  onHold: Pause,
  dropped: Ban,
};

/** Closes a popover on an outside click or Escape. */
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
  const { setStatus, removeTracked } = useLibrary.getState();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  const status = entry?.status ?? null;
  const Icon = status ? statusIcons[status] : ListPlus;

  return (
    <div className="status-menu" ref={ref}>
      <button className={`button button--large ${status ? `status-button status-button--${status}` : ""}`} onClick={() => setOpen(!open)}>
        <Icon size={18} />
        {status ? statusLabel(status) : "В список"}
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
                  setStatus(title, item.id);
                  setOpen(false);
                }}
              >
                <ItemIcon size={16} />
                <span>{item.label}</span>
                {item.id === status && <Check size={15} />}
              </button>
            );
          })}
          {entry && (
            <button
              className="popover__item popover__item--danger"
              onClick={() => {
                removeTracked(key);
                setOpen(false);
              }}
            >
              <Trash2 size={16} />
              <span>Убрать из списка</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function RatingStars({ title }: { title: TitleRef }) {
  const rating = useLibrary((state) => state.tracked[titleKey(title.type, title.id)]?.rating ?? null);
  const setRating = useLibrary((state) => state.setRating);
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? rating ?? 0;

  return (
    <div className="rating-stars" onMouseLeave={() => setHover(null)}>
      <span className="rating-stars__label">Моя оценка</span>
      <div className="rating-stars__row">
        {Array.from({ length: maxRating }, (_, index) => {
          const value = index + 1;
          return (
            <button
              key={value}
              aria-label={`Оценка ${value}`}
              className={value <= shown ? "is-on" : ""}
              onMouseEnter={() => setHover(value)}
              // Clicking the current rating again removes it.
              onClick={() => setRating(title, value === rating ? null : value)}
            >
              <Star size={19} fill={value <= shown ? "currentColor" : "none"} />
            </button>
          );
        })}
      </div>
      <span className="rating-stars__value">{shown > 0 ? `${shown} из ${maxRating}` : "нет оценки"}</span>
    </div>
  );
}

/** Compact marker for poster cards: status icon and the personal rating. */
export function TrackBadge({ type, id }: Pick<TitleRef, "type" | "id">) {
  const entry = useLibrary((state) => state.tracked[titleKey(type, id)]);
  if (!entry || (!entry.status && !entry.rating)) return null;
  const Icon = entry.status ? statusIcons[entry.status] : null;
  return (
    <span className={`track-badge ${entry.status ? `track-badge--${entry.status}` : ""}`} title={entry.status ? statusLabel(entry.status) : "Моя оценка"}>
      {Icon && <Icon size={12} />}
      {entry.rating && (
        <>
          <Star size={10} fill="currentColor" />
          {entry.rating}
        </>
      )}
    </span>
  );
}
