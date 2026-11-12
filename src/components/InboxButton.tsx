import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, CheckCheck, CircleArrowUp, Download, Trash2, Tv } from "lucide-react";
import { useT } from "../lib/i18n";
import { useInbox, type InboxKind } from "../state/inbox";

const kindIcons: Record<InboxKind, typeof Bell> = {
  episodes: Tv,
  download: Download,
  update: CircleArrowUp,
  info: Bell,
};

function ago(at: number, locale: string): string {
  const minutes = Math.round((Date.now() - at) / 60000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (minutes < 60) return format.format(-Math.max(0, minutes), "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format.format(-hours, "hour");
  return format.format(-Math.round(hours / 24), "day");
}

export function InboxButton() {
  const { t, locale } = useT();
  const items = useInbox((state) => state.items);
  const unread = items.filter((item) => !item.read).length;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="inbox" ref={rootRef}>
      <button
        className={`inbox__button ${unread > 0 ? "has-unread" : ""}`}
        aria-label={unread > 0 ? t("inbox.unread", { count: unread }) : t("inbox.title")}
        title={t("inbox.title")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={17} />
        {unread > 0 && <span className="inbox__badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="inbox__panel" role="dialog" aria-label={t("inbox.title")}>
          <div className="inbox__head">
            <strong>{t("inbox.title")}</strong>
            {items.length > 0 && (
              <div className="inbox__actions">
                <button className="icon-button" title={t("inbox.markAllRead")} aria-label={t("inbox.markAllRead")} disabled={unread === 0} onClick={() => useInbox.getState().markAllRead()}>
                  <CheckCheck size={16} />
                </button>
                <button className="icon-button" title={t("inbox.clear")} aria-label={t("inbox.clear")} onClick={() => useInbox.getState().clear()}>
                  <Trash2 size={15} />
                </button>
              </div>
            )}
          </div>
          {items.length === 0 ? (
            <p className="inbox__empty">{t("inbox.empty")}</p>
          ) : (
            <ul className="inbox__list">
              {items.map((item) => {
                const Icon = kindIcons[item.kind] ?? Bell;
                return (
                  <li key={item.id}>
                    <button
                      className={`inbox__item ${item.read ? "" : "is-unread"}`}
                      onClick={() => {
                        useInbox.getState().markRead(item.id);
                        if (item.link) {
                          navigate(item.link);
                          setOpen(false);
                        }
                      }}
                    >
                      <Icon size={16} />
                      <span className="inbox__text">
                        <strong>{item.title}</strong>
                        <span>{item.body}</span>
                      </span>
                      <time dateTime={new Date(item.at).toISOString()}>{ago(item.at, locale)}</time>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
