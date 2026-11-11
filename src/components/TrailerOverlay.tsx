import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, X } from "lucide-react";
import { isDesktop } from "../lib/backend";
import { useT, type MessageKey } from "../lib/i18n";
import type { TitleVideo } from "../lib/tmdb";

const embedBase = "https://www.youtube-nocookie.com/embed";
const watchBase = "https://www.youtube.com/watch";

const kindLabels: Record<TitleVideo["kind"], MessageKey> = {
  trailer: "trailer.kind.trailer",
  teaser: "trailer.kind.teaser",
  other: "trailer.kind.other",
};

async function openOnYouTube(key: string): Promise<void> {
  const url = `${watchBase}?v=${encodeURIComponent(key)}`;
  if (!isDesktop) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export function TrailerOverlay({ title, videos, onClose }: { title: string; videos: TitleVideo[]; onClose: () => void }) {
  const { t } = useT();
  const [currentKey, setCurrentKey] = useState(videos[0]?.key);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const current = videos.find((video) => video.key === currentKey) ?? videos[0];

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!current) return null;

  const keepFocusInside = (event: ReactKeyboardEvent) => {
    if (event.key !== "Tab") return;
    const stops = dialogRef.current?.querySelectorAll<HTMLElement>("button, iframe");
    if (!stops || stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    const edge = event.shiftKey ? first : last;
    if (document.activeElement !== edge) return;
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  };

  const labelOf = (video: TitleVideo) => video.name || t(kindLabels[video.kind]);

  return createPortal(
    <div
      className="trailer"
      onMouseDown={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={keepFocusInside}
    >
      <div
        ref={dialogRef}
        className="trailer__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("trailer.label", { title })}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="trailer__head">
          <div className="trailer__titles">
            <h2>{title}</h2>
            <div className="trailer__sub">{labelOf(current)}</div>
          </div>
          <button
            className="text-button"
            onClick={() => {
              onClose();
              void openOnYouTube(current.key);
            }}
          >
            <ExternalLink size={14} />
            {t("trailer.openOnYouTube")}
          </button>
          <button ref={closeRef} className="trailer__close" aria-label={t("common.close")} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="trailer__frame">
          <iframe
            key={current.key}
            src={`${embedBase}/${encodeURIComponent(current.key)}?autoplay=1&rel=0`}
            title={labelOf(current)}
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>

        {videos.length > 1 && (
          <div className="trailer__videos">
            {videos.map((video) => (
              <button
                key={video.key}
                className={`chip chip--compact ${video.key === current.key ? "is-active" : ""}`}
                aria-pressed={video.key === current.key}
                title={labelOf(video)}
                onClick={() => setCurrentKey(video.key)}
              >
                {labelOf(video)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
