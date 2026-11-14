import { useEffect, useState, type RefObject } from "react";

export function useGridColumns(ref: RefObject<HTMLElement | null>, fallback = 6): number {
  const [columns, setColumns] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const count = getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length;
      if (count > 0) setColumns(count);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return columns;
}

export function useNearEnd(ref: RefObject<HTMLElement | null>, active: boolean, onNear: () => void): void {
  useEffect(() => {
    const element = ref.current;
    if (!element || !active) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onNear();
    }, { rootMargin: "0px 0px 900px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active, onNear]);
}
