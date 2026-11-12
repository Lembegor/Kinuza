import type { GridDensity } from "../state/settings";

export const accentColors = [
  { id: "", color: "#e23a3f" },
  { id: "orange", color: "#ef7d2f" },
  { id: "amber", color: "#e3a72f" },
  { id: "green", color: "#3fbf7f" },
  { id: "teal", color: "#2bb3b1" },
  { id: "blue", color: "#4a8df0" },
  { id: "violet", color: "#8b6cf0" },
  { id: "pink", color: "#e0569b" },
] as const;

function shade(hex: string, amount: number): string {
  const value = parseInt(hex.slice(1), 16);
  const channel = (shift: number) => Math.min(255, Math.max(0, ((value >> shift) & 255) + amount));
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, "0")).join("")}`;
}

function soft(hex: string): string {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, 0.16)`;
}

export function applyAppearance(accent: string, density: GridDensity): void {
  const root = document.documentElement;
  const chosen = accentColors.find((item) => item.id === accent) ?? accentColors[0];
  if (chosen.id === "") {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-hover");
    root.style.removeProperty("--accent-soft");
  } else {
    root.style.setProperty("--accent", chosen.color);
    root.style.setProperty("--accent-hover", shade(chosen.color, 18));
    root.style.setProperty("--accent-soft", soft(chosen.color));
  }
  if (density === "normal") delete root.dataset.density;
  else root.dataset.density = density;
}
