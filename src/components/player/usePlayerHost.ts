import { useEffect, useRef } from "react";
import { mpv } from "../../lib/mpv";
import { usePlayerPlacement, type Placement } from "../../state/playerPlacement";

const dockWidth = 400;
const dockHeight = 225;
const dockGap = 20;
const awayBelow = 0.15;
const backAbove = 0.35;

type Movable = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };

function move(host: HTMLElement, parent: HTMLElement): void {
  if (host.parentElement === parent) return;
  const target = parent as Movable;
  if (host.isConnected && typeof target.moveBefore === "function") {
    try {
      target.moveBefore(host, null);
      return;
    } catch {
      parent.appendChild(host);
      return;
    }
  }
  parent.appendChild(host);
}

function usesMpv(): boolean {
  return document.documentElement.classList.contains("is-mpv");
}

export function usePlayerHost(active: boolean, placement: Placement): HTMLElement {
  const hostRef = useRef<HTMLElement | null>(null);
  if (!hostRef.current) {
    const host = document.createElement("div");
    host.className = "player-host";
    hostRef.current = host;
  }
  const host = hostRef.current;
  const slot = usePlayerPlacement((state) => state.slot);

  useEffect(() => {
    if (!active) {
      host.remove();
      return;
    }
    move(host, placement === "inline" && slot ? slot : document.body);
    host.dataset.placement = placement;
    const root = document.documentElement;
    root.classList.toggle("is-player-inline", placement === "inline");
    root.classList.toggle("is-player-docked", placement === "docked");
    return () => {
      root.classList.remove("is-player-inline", "is-player-docked");
    };
  }, [active, placement, slot, host]);

  useEffect(() => () => host.remove(), [host]);

  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    let placed = "";
    const place = (left: number, top: number, width: number, height: number) => {
      if (!usesMpv()) {
        placed = "";
        return;
      }
      const scale = window.devicePixelRatio || 1;
      const next = [left, top, width, height].map((value) => Math.round(value * scale));
      const key = next.join(",");
      if (key === placed) return;
      placed = key;
      void mpv.place(next[0], next[1], next[2], next[3]).catch(() => undefined);
    };
    let holed = "";
    const hole = (left: number, top: number, right: number, bottom: number) => {
      const next = [left, top, right, bottom].map(Math.round);
      const key = next.join(",");
      if (key === holed) return;
      holed = key;
      root.style.setProperty("--hole-l", `${next[0]}px`);
      root.style.setProperty("--hole-t", `${next[1]}px`);
      root.style.setProperty("--hole-r", `${next[2]}px`);
      root.style.setProperty("--hole-b", `${next[3]}px`);
    };

    let punch: HTMLDivElement | null = null;
    let punched = "";
    const window_ = (scroller: Element, rect: DOMRect) => {
      if (!punch || punch.parentElement !== scroller) {
        punch?.remove();
        punch = document.createElement("div");
        punch.className = "player-punch";
        punch.appendChild(document.createElement("i"));
        scroller.prepend(punch);
        punched = "";
      }
      const origin = punch.getBoundingClientRect();
      const next = [rect.left - origin.left, rect.top - origin.top, rect.width, rect.height].map((value) => Math.round(value * 2) / 2);
      const key = next.join(",");
      if (key === punched) return;
      punched = key;
      const box = punch.firstElementChild as HTMLElement;
      box.style.left = `${next[0]}px`;
      box.style.top = `${next[1]}px`;
      box.style.width = `${next[2]}px`;
      box.style.height = `${next[3]}px`;
    };
    const closeWindow = () => {
      punch?.remove();
      punch = null;
    };

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (width === 0 || height === 0) return;
      if (placement === "full") {
        closeWindow();
        place(0, 0, width, height);
        return;
      }
      if (placement === "docked") {
        const left = width - dockGap - dockWidth;
        const top = height - dockGap - dockHeight;
        closeWindow();
        hole(left, top, width - dockGap, height - dockGap);
        place(left, top, dockWidth, dockHeight);
      }
      const { slot: current, away, setAway } = usePlayerPlacement.getState();
      if (!current || !current.isConnected) return;
      const rect = current.getBoundingClientRect();
      const frameRect = document.querySelector(".content")?.getBoundingClientRect();
      const bounds = frameRect ?? new DOMRect(0, 0, width, height);
      const visibleWidth = Math.max(0, Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left));
      const visibleHeight = Math.max(0, Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top));
      const visible = rect.width > 0 && rect.height > 0 ? (visibleWidth * visibleHeight) / (rect.width * rect.height) : 0;
      if (!away && visible < awayBelow) setAway(true);
      else if (away && visible > backAbove) setAway(false);
      if (placement !== "inline") return;
      place(rect.left, rect.top, rect.width, rect.height);
      const scroller = current.closest(".page-scroller");
      if (scroller) {
        const area = scroller.getBoundingClientRect();
        window_(scroller, rect);
        hole(area.left, area.top, area.left + scroller.clientWidth, area.top + scroller.clientHeight);
        return;
      }
      closeWindow();
      hole(Math.max(rect.left, bounds.left), Math.max(rect.top, bounds.top), Math.min(rect.right, bounds.right), Math.min(rect.bottom, bounds.bottom));
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      closeWindow();
      if (usesMpv()) {
        const scale = window.devicePixelRatio || 1;
        void mpv.place(0, 0, Math.round(window.innerWidth * scale), Math.round(window.innerHeight * scale)).catch(() => undefined);
      }
    };
  }, [active, placement]);

  return host;
}
