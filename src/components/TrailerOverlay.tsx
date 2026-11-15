import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, X } from "lucide-react";
import { isDesktop } from "../lib/backend";
import { useT, type MessageKey } from "../lib/i18n";
import type { TitleVideo } from "../lib/tmdb";

const embedBase = "https://www.youtube-nocookie.com/embed";
const playerOrigins = ["https://www.youtube-nocookie.com", "https://www.youtube.com"];

export interface TrailerWatch {
  seconds: number;
  watched: number;
  length: number;
  external: boolean;
}
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

export function TrailerOverlay({
  title,
  videos,
  onClose,
  onWatched,
}: {
  title: string;
  videos: TitleVideo[];
  onClose: () => void;
  onWatched?: (watch: TrailerWatch) => void;
}) {
  const { t } = useT();
  const [currentKey, setCurrentKey] = useState(videos[0]?.key);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const current = videos.find((video) => video.key === currentKey) ?? videos[0];
  const frameRef = useRef<HTMLIFrameElement>(null);
  const watch = useRef({ openedAt: Date.now(), watched: 0, length: 0, external: false });
  const reportRef = useRef(onWatched);
  reportRef.current = onWatched;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!playerOrigins.includes(event.origin) || typeof event.data !== "string") return;
      try {
        const data = JSON.parse(event.data) as { event?: string; info?: { currentTime?: number; duration?: number } };
        if (data.event !== "infoDelivery" || !data.info) return;
        if (typeof data.info.currentTime === "number") watch.current.watched = Math.max(watch.current.watched, data.info.currentTime);
        if (typeof data.info.duration === "number" && data.info.duration > 0) watch.current.length = data.info.duration;
      } catch {
        return;
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      const { openedAt, watched, length, external } = watch.current;
      reportRef.current?.({ seconds: Math.round((Date.now() - openedAt) / 1000), watched: Math.round(watched), length: Math.round(length), external });
    };
  }, []);

  const listen = () => {
    const frame = frameRef.current?.contentWindow;
    if (!frame) return;
    for (const origin of playerOrigins) frame.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), origin);
  };

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
              watch.current.external = true;
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
            ref={frameRef}
            key={current.key}
            onLoad={listen}
            src={`${embedBase}/${encodeURIComponent(current.key)}?autoplay=1&rel=0&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
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
