import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useT } from "../lib/i18n";
import { imageUrl, tmdb, type MediaType } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { isTopDialog, useDialogFocus } from "../lib/useDialogFocus";
import { Row } from "./Cards";

const minimumImages = 3;

function Viewer({ images, start, onClose }: { images: string[]; start: number; onClose: () => void }) {
  const { t } = useT();
  const [index, setIndex] = useState(start);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, true);
  const step = useCallback((delta: number) => setIndex((value) => (value + delta + images.length) % images.length), [images.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isTopDialog(dialogRef)) return;
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        onClose();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, step]);

  const next = imageUrl(images[(index + 1) % images.length], "w1280");

  return (
    <div className="gallery-viewer" ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("title.gallery")} onMouseDown={onClose}>
      <img
        key={images[index]}
        className="gallery-viewer__image"
        src={imageUrl(images[index], "original") ?? undefined}
        alt=""
        draggable={false}
        onMouseDown={(event) => event.stopPropagation()}
      />
      {next && <link rel="prefetch" href={next} />}
      <button className="gallery-viewer__close icon-button" data-autofocus aria-label={t("common.close")} onMouseDown={(event) => event.stopPropagation()} onClick={onClose}>
        <X size={20} />
      </button>
      {images.length > 1 && (
        <>
          <button className="gallery-viewer__nav is-previous" aria-label={t("title.gallery.previous")} onMouseDown={(event) => event.stopPropagation()} onClick={() => step(-1)}>
            <ChevronLeft size={28} />
          </button>
          <button className="gallery-viewer__nav is-next" aria-label={t("title.gallery.next")} onMouseDown={(event) => event.stopPropagation()} onClick={() => step(1)}>
            <ChevronRight size={28} />
          </button>
          <span className="gallery-viewer__count">
            {index + 1} / {images.length}
          </span>
        </>
      )}
    </div>
  );
}

export function Gallery({ type, id }: { type: MediaType; id: number }) {
  const { t } = useT();
  const images = useAsync(() => tmdb.images(type, id), [type, id]);
  const [open, setOpen] = useState<number | null>(null);
  const list = images.data ?? [];
  if (list.length < minimumImages) return null;
  return (
    <>
      <Row title={t("title.gallery")}>
        {list.map((path, index) => (
          <button key={path} className="gallery-card" aria-label={t("title.gallery.open", { number: index + 1 })} onClick={() => setOpen(index)}>
            <img src={imageUrl(path, "w780") ?? undefined} alt="" loading="lazy" draggable={false} />
          </button>
        ))}
      </Row>
      {open !== null && <Viewer images={list} start={open} onClose={() => setOpen(null)} />}
    </>
  );
}
