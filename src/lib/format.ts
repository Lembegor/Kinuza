import { currentLocale, t, type MessageKey } from "./i18n";

const byteUnits: MessageKey[] = ["common.bytes.b", "common.bytes.kb", "common.bytes.mb", "common.bytes.gb", "common.bytes.tb"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${t(byteUnits[0])}`;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), byteUnits.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${t(byteUnits[exponent])}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return t("common.perSecond", { size: formatBytes(bytesPerSecond) });
}

/** 3725 -> "1:02:05", 125 -> "2:05". */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const seconds = Math.floor(totalSeconds % 60);
  const minutes = Math.floor((totalSeconds / 60) % 60);
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function formatRuntime(minutes: number | null): string {
  if (!minutes) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return t("common.duration.minutes", { minutes: rest });
  return rest === 0 ? t("common.duration.hours", { hours }) : t("common.duration.hoursMinutes", { hours, minutes: rest });
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return t("common.duration.lessThanMinute");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("common.duration.minutes", { minutes });
  const hours = Math.floor(minutes / 60);
  return t("common.duration.hoursMinutes", { hours, minutes: minutes % 60 });
}

/** One formatter per locale: building one is costly, and a page of episodes formats many dates. */
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(locale: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" });
    dateFormatters.set(locale, formatter);
  }
  return formatter;
}

const isoDayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatDate(isoDate: string): string {
  if (!isoDate) return "";
  // A bare day ("1970-07-30") parses as midnight UTC, which west of UTC is still the evening
  // before; built from its parts, it is that day wherever the user is.
  const day = isoDayPattern.exec(isoDate);
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(isoDate);
  return Number.isNaN(date.getTime()) ? "" : dateFormatter(currentLocale()).format(date);
}

const momentFormatters = new Map<string, Intl.DateTimeFormat>();

/** A moment in a list of recent events: "11 нояб., 14:05:09". */
export function formatMoment(timestamp: number): string {
  const locale = currentLocale();
  let formatter = momentFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    momentFormatters.set(locale, formatter);
  }
  return formatter.format(timestamp);
}
