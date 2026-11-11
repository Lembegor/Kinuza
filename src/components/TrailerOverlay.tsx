// Trailer overlay: a title's trailers and teasers played inside the app, over a dimmed page.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, X } from "lucide-react";
import { isDesktop } from "../lib/backend";
import { useT, type MessageKey } from "../lib/i18n";
import type { TitleVideo } from "../lib/tmdb";

/** The cookie-less player: watching a trailer here does not feed the user's YouTube history. */
const embedBase = "https://www.youtube-nocookie.com/embed";
const watchBase = "https://www.youtube.com/watch";

const kindLabels: Record<TitleVideo["kind"], MessageKey> = {
  trailer: "trailer.kind.trailer",
  teaser: "trailer.kind.teaser",
  other: "trailer.kind.other",
};

/** The way out for a video whose owner forbids playing it anywhere but on YouTube itself. */
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

  // Focus moves into the overlay and, when it closes, back to whatever opened it.
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

  // Tab goes round the overlay instead of wandering off into the page underneath.
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

  // Rendered at the top of the document: an ancestor's animation or transform must not become
  // the box the overlay is positioned in.
  return createPortal(
    <div
      className="trailer"
      onMouseDown={(event) => {
        // Left alone, the press would move focus to the page right after it was handed back to the opener.
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
              // Two players at once would talk over each other.
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
          {/* Keyed by the video, so switching starts a fresh player; closing removes it, and with it the sound. */}
          <iframe
            key={current.key}
            src={`${embedBase}/${encodeURIComponent(current.key)}?autoplay=1&rel=0`}
            title={labelOf(current)}
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            // YouTube refuses to play for an embedding page that does not say who it is.
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
