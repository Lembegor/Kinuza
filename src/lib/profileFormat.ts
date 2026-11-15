import { currentLocale, t, tn, type MessageKey } from "./i18n";
import type { Kind } from "./profileStats";

export const kindLabels: Record<Kind, MessageKey> = {
  movie: "profile.kind.movie",
  tv: "profile.kind.tv",
  anime: "profile.kind.anime",
};

export function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

export function formatSeconds(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return t("common.duration.lessThanMinute");
  if (minutes < 60) return t("common.duration.minutes", { minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 10 || rest === 0) return t("common.duration.hours", { hours: formatNumber(Math.round(minutes / 60)) });
  return t("common.duration.hoursMinutes", { hours, minutes: rest });
}

export function formatHoursShort(seconds: number): string {
  const hours = seconds / 3600;
  if (hours < 1) return t("common.duration.minutes", { minutes: Math.round(seconds / 60) });
  return t("common.duration.hours", { hours: formatNumber(hours, hours < 10 ? 1 : 0) });
}

export function formatDaysHours(seconds: number): string {
  const totalHours = Math.floor(seconds / 3600);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days === 0) return "";
  if (hours === 0) return tn("profile.days", days);
  return t("profile.daysHours", { days: tn("profile.days", days), hours: tn("profile.hours", hours) });
}

export function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function formatDayLabel(day: string, now = Date.now()): string {
  const date = parseDay(day);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const difference = Math.round((startOfToday - date.getTime()) / 86_400_000);
  const dayMonth = new Intl.DateTimeFormat(currentLocale(), {
    day: "numeric",
    month: "long",
    ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  }).format(date);
  if (difference === 0) return t("profile.history.today", { date: dayMonth });
  if (difference === 1) return t("profile.history.yesterday", { date: dayMonth });
  const weekday = new Intl.DateTimeFormat(currentLocale(), { weekday: "long" }).format(date);
  return `${weekday.charAt(0).toLocaleUpperCase()}${weekday.slice(1)}, ${dayMonth}`;
}

export function formatMonth(month: string, style: "long" | "short" = "long", withYear = false): string {
  const [y, m] = month.split("-").map(Number);
  const text = new Intl.DateTimeFormat(currentLocale(), { month: style, ...(withYear ? { year: "numeric" } : {}) }).format(new Date(y, m - 1, 1));
  return text.replace(/\.$/, "");
}

export function monthNameStandalone(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const parts = new Intl.DateTimeFormat(currentLocale(), { month: "long", year: "numeric" }).formatToParts(new Date(y, m - 1, 1));
  const name = parts.find((part) => part.type === "month")?.value ?? "";
  return `${name.charAt(0).toLocaleUpperCase()}${name.slice(1)}`;
}

export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([currentLocale()], { type: "language" }).of(code) ?? code;
    return `${name.charAt(0).toLocaleUpperCase()}${name.slice(1)}`;
  } catch {
    return code;
  }
}
