import { Activity, memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Routes, useLocation, useNavigationType, type Location, type NavigationType } from "react-router-dom";

const keptPages = 6;
const restoreLimitMs = 1500;
const settleMs = 1000;

interface Entry {
  id: number;
  idx: number;
  key: string;
  location: Location;
  restoreTop?: number;
}

interface Anchor {
  element: Element;
  top: number;
  scrollTop: number;
}

interface StackState {
  location: Location | null;
  entries: Entry[];
  activeId: number;
}

let nextId = 1;
const evictedTops = new Map<string, number>();

function historyIndex(): number {
  const index = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof index === "number" ? index : 0;
}

function advance(state: StackState, location: Location, action: NavigationType, idx: number, tops: Map<number, number>): StackState {
  let entries = action === "PUSH" ? state.entries.filter((entry) => entry.idx < idx) : state.entries;
  let active = entries.find((entry) => entry.key === location.key);

  if (active) {
    const found = active;
    active = { ...found, location };
    entries = entries.map((entry) => (entry === found ? active! : entry));
  } else if (action === "REPLACE" && entries.some((entry) => entry.idx === idx)) {
    const current = entries.find((entry) => entry.idx === idx)!;
    active = { ...current, key: location.key, location };
    entries = entries.map((entry) => (entry === current ? active! : entry));
  } else {
    const restoreTop = action === "POP" ? evictedTops.get(location.key) : undefined;
    active = { id: nextId++, idx, key: location.key, location, restoreTop };
    entries = [...entries.filter((entry) => entry.idx !== idx), active].sort((a, b) => a.idx - b.idx);
  }

  while (entries.length > keptPages) {
    const farthest = entries.reduce((worst, entry) => (Math.abs(entry.idx - idx) > Math.abs(worst.idx - idx) ? entry : worst));
    const top = tops.get(farthest.id);
    if (top !== undefined) evictedTops.set(farthest.key, top);
    tops.delete(farthest.id);
    entries = entries.filter((entry) => entry !== farthest);
  }

  return { location, entries, activeId: active.id };
}

function anchorTarget(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  return target.closest("a, button, [role='button']") ?? target;
}

interface KeptPageProps {
  entry: Entry;
  active: boolean;
  routes: ReactNode;
  tops: Map<number, number>;
}

const KeptPage = memo(function KeptPage({ entry, active, routes, tops }: KeptPageProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<Anchor | null>(null);
  const activeRef = useRef(active);
  const shownBefore = useRef(false);
  activeRef.current = active;

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      if (activeRef.current) tops.set(entry.id, element.scrollTop);
    };
    const onClick = (event: MouseEvent) => {
      const target = anchorTarget(event.target);
      if (!target) return;
      const top = target.getBoundingClientRect().top - element.getBoundingClientRect().top;
      anchorRef.current = { element: target, top, scrollTop: element.scrollTop };
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("click", onClick, true);
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("click", onClick, true);
    };
  }, [entry.id, tops]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!active || !element) return;
    const firstShow = !shownBefore.current;
    shownBefore.current = true;
    const startedAt = performance.now();
    let frame = 0;

    if (firstShow) {
      const target = entry.restoreTop;
      if (target === undefined) return;
      const restore = () => {
        element.scrollTo({ top: target });
        const reached = Math.abs(element.scrollTop - target) < 2;
        if (!reached && performance.now() - startedAt < restoreLimitMs) frame = requestAnimationFrame(restore);
      };
      restore();
      return () => cancelAnimationFrame(frame);
    }

    const anchor = anchorRef.current;
    const lastTop = tops.get(entry.id) ?? 0;
    if (!anchor || Math.abs(anchor.scrollTop - lastTop) >= 2) return;
    const align = () => {
      if (!anchor.element.isConnected) return;
      const top = anchor.element.getBoundingClientRect().top - element.getBoundingClientRect().top;
      const shift = top - anchor.top;
      if (Math.abs(shift) >= 1) element.scrollTop += shift;
    };
    align();
    const content = element.firstElementChild;
    const observer = new ResizeObserver(() => {
      if (performance.now() - startedAt < settleMs) align();
      else observer.disconnect();
    });
    if (content) observer.observe(content);
    const stop = () => observer.disconnect();
    element.addEventListener("wheel", stop, { passive: true, once: true });
    element.addEventListener("pointerdown", stop, { once: true });
    const timer = setTimeout(stop, settleMs);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      element.removeEventListener("wheel", stop);
      element.removeEventListener("pointerdown", stop);
    };
  }, [active, entry.id, entry.restoreTop, tops]);

  return (
    <Activity mode={active ? "visible" : "hidden"}>
      <div className="page-scroller" ref={scrollRef}>
        <Routes location={entry.location}>{routes}</Routes>
      </div>
    </Activity>
  );
});

/**
 * Keeps the last few history entries mounted under a hidden <Activity>, so going back shows the page
 * exactly as it was left: scroll position, row positions, loaded data and component state.
 */
export function PageStack({ routes }: { routes: ReactNode }) {
  const location = useLocation();
  const action = useNavigationType();
  const tops = useRef(new Map<number, number>()).current;
  const [state, setState] = useState<StackState>({ location: null, entries: [], activeId: 0 });

  let current = state;
  if (state.location !== location) {
    current = advance(state, location, action, historyIndex(), tops);
    setState(current);
  }

  return current.entries.map((entry) => (
    <KeptPage key={entry.id} entry={entry} active={entry.id === current.activeId} routes={routes} tops={tops} />
  ));
}
