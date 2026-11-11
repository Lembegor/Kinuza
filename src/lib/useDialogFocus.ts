import { useEffect, type RefObject } from "react";

const focusableSelector = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

const openDialogs: RefObject<HTMLElement | null>[] = [];

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => element.getClientRects().length > 0);
}

export function useDialogFocus(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openDialogs.push(ref);

    const frame = requestAnimationFrame(() => {
      const root = ref.current;
      if (!root || root.contains(document.activeElement)) return;
      const preferred = root.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? focusables(root)[0] ?? root;
      preferred.focus();
    });

    const onKey = (event: KeyboardEvent) => {
      const root = ref.current;
      if (event.key !== "Tab" || !root || openDialogs[openDialogs.length - 1] !== ref) return;
      const stops = focusables(root);
      if (stops.length === 0) {
        event.preventDefault();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const inside = root.contains(document.activeElement);
      if (!inside || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey, true);
      const index = openDialogs.lastIndexOf(ref);
      if (index >= 0) openDialogs.splice(index, 1);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [active, ref]);
}

export function isTopDialog(ref: RefObject<HTMLElement | null>): boolean {
  return openDialogs[openDialogs.length - 1] === ref;
}
