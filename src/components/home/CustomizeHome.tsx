import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ArrowDown, ArrowUp, GripVertical, X } from "lucide-react";
import { useDialogFocus } from "../../lib/useDialogFocus";
import { useT } from "../../lib/i18n";
import { homeBlocks, isDefaultLayout, moveBlock, resetHomeLayout, setBlockHidden, useHomeLayout, type HomeBlockId } from "../../state/homeLayout";
import { useSettings } from "../../state/settings";

interface Drag {
  id: HomeBlockId;
  pointer: number;
}

export function CustomizeHome({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const { order, hidden } = useHomeLayout();
  const rawOrder = useSettings((state) => state.homeOrder);
  const rawHidden = useSettings((state) => state.homeHidden);
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [focusId, setFocusId] = useState<HomeBlockId | null>(null);
  useDialogFocus(panelRef);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!focusId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-block="${focusId}"] .home-custom__grip`)?.focus();
    setFocusId(null);
  }, [focusId, order]);

  const move = (id: HomeBlockId, direction: -1 | 1) => {
    const index = order.indexOf(id);
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    moveBlock(id, target);
    setFocusId(id);
  };

  const onGripKey = (id: HomeBlockId, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (!event.altKey && !event.ctrlKey) return;
    event.preventDefault();
    move(id, event.key === "ArrowUp" ? -1 : 1);
  };

  const startDrag = (id: HomeBlockId, event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setDrag({ id, pointer: event.pointerId });
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== drag.pointer) return;
      if (event.buttons === 0) {
        setDrag(null);
        return;
      }
      const list = listRef.current;
      if (!list) return;
      const rows = [...list.querySelectorAll<HTMLElement>("[data-block]")];
      const target = rows.findIndex((row) => {
        const box = row.getBoundingClientRect();
        return event.clientY >= box.top && event.clientY <= box.bottom;
      });
      const current = rows.findIndex((row) => row.dataset.block === drag.id);
      if (target >= 0 && target !== current) moveBlock(drag.id, target);
    };
    const onEnd = (event: globalThis.PointerEvent) => {
      if (event.pointerId === drag.pointer) setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, [drag]);

  return (
    <div className="home-custom" role="presentation">
      <div className="home-custom__dim" onClick={onClose} />
      <aside className="home-custom__panel" role="dialog" aria-modal="true" aria-labelledby="home-custom-title" ref={panelRef}>
        <div className="home-custom__head">
          <h2 id="home-custom-title">{t("home.custom.title")}</h2>
          <button className="icon-button" aria-label={t("common.close")} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <p className="home-custom__hint">{t("home.custom.hint")}</p>
        <ol className="home-custom__list" ref={listRef}>
          {order.map((id, index) => {
            const info = homeBlocks.find((block) => block.id === id)!;
            const on = !hidden.has(id);
            return (
              <li key={id} data-block={id} className={`home-custom__item ${drag?.id === id ? "is-dragging" : ""} ${on ? "" : "is-off"}`}>
                <button
                  className="home-custom__grip"
                  aria-label={t("home.custom.move", { name: t(info.nameKey) })}
                  title={t("home.custom.moveHint")}
                  onPointerDown={(event) => startDrag(id, event)}
                  onKeyDown={(event) => onGripKey(id, event)}
                >
                  <GripVertical size={16} />
                </button>
                <span className="home-custom__text">
                  <b>{t(info.nameKey)}</b>
                  <span>{t(info.hintKey)}</span>
                </span>
                <span className="home-custom__steps">
                  <button className="icon-button" aria-label={t("home.custom.up", { name: t(info.nameKey) })} disabled={index === 0} onClick={() => move(id, -1)}>
                    <ArrowUp size={14} />
                  </button>
                  <button className="icon-button" aria-label={t("home.custom.down", { name: t(info.nameKey) })} disabled={index === order.length - 1} onClick={() => move(id, 1)}>
                    <ArrowDown size={14} />
                  </button>
                </span>
                <button role="switch" aria-checked={on} aria-label={t(info.nameKey)} className={`toggle ${on ? "is-on" : ""}`} onClick={() => setBlockHidden(id, on)}>
                  <i />
                </button>
              </li>
            );
          })}
        </ol>
        <button className="button home-custom__reset" disabled={isDefaultLayout(rawOrder, rawHidden)} onClick={resetHomeLayout}>
          {t("home.custom.reset")}
        </button>
      </aside>
    </div>
  );
}
