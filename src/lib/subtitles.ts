// Parses SRT, WebVTT and ASS/SSA subtitles into plain timed cues.

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Subtitles in the wild are often Windows-1251; UTF-8 is tried first and must decode cleanly. */
export function decodeSubtitleBytes(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

function parseTimestamp(value: string): number {
  const match = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(value.trim());
  if (!match) return Number.NaN;
  const [, hours = "0", minutes, seconds, fraction] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(fraction.padEnd(3, "0")) / 1000;
}

function stripMarkup(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

function parseSrtOrVtt(content: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = content.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startText, endText] = lines[timingIndex].split("-->");
    const start = parseTimestamp(startText);
    const end = parseTimestamp(endText);
    const text = stripMarkup(lines.slice(timingIndex + 1).join("\n"));
    if (Number.isFinite(start) && Number.isFinite(end) && text) cues.push({ start, end, text });
  }
  return cues;
}

function parseAss(content: string): Cue[] {
  const cues: Cue[] = [];
  let fields: string[] = [];
  let inEvents = false;
  for (const line of content.replace(/\r/g, "").split("\n")) {
    if (line.startsWith("[")) {
      inEvents = /^\[events\]/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (line.startsWith("Format:")) {
      fields = line.slice(7).split(",").map((field) => field.trim().toLowerCase());
      continue;
    }
    if (!line.startsWith("Dialogue:") || fields.length === 0) continue;

    // The text is the last field and may itself contain commas.
    const values = line.slice(9).split(",");
    const head = values.slice(0, fields.length - 1);
    const text = stripMarkup(values.slice(fields.length - 1).join(","));
    const start = parseTimestamp(head[fields.indexOf("start")] ?? "");
    const end = parseTimestamp(head[fields.indexOf("end")] ?? "");
    if (Number.isFinite(start) && Number.isFinite(end) && text) cues.push({ start, end, text });
  }
  return cues;
}

export function parseSubtitles(content: string): Cue[] {
  const cues = /^\[script info\]/im.test(content) ? parseAss(content) : parseSrtOrVtt(content);
  return cues.sort((a, b) => a.start - b.start);
}

/** Cues are few thousand at most and usually overlap rarely, so a linear scan is enough. */
export function activeCueText(cues: Cue[], time: number): string {
  return cues
    .filter((cue) => time >= cue.start && time <= cue.end)
    .map((cue) => cue.text)
    .join("\n");
}

const languageNames = new Intl.DisplayNames(["ru"], { type: "language", fallback: "none" });

/** Spellings that are not plain ISO 639-1/-3 codes: bibliographic codes and full English names. */
const languageAliases: Record<string, string> = {
  rus: "ru", russian: "ru", eng: "en", english: "en", ukr: "uk", ukrainian: "uk",
  ger: "de", deu: "de", german: "de", fre: "fr", fra: "fr", french: "fr",
  spa: "es", spanish: "es", ita: "it", italian: "it", por: "pt", portuguese: "pt",
  pol: "pl", polish: "pl", dut: "nl", nld: "nl", dutch: "nl", jpn: "ja", jap: "ja", japanese: "ja",
  chi: "zh", zho: "zh", chinese: "zh", kor: "ko", korean: "ko", tur: "tr", turkish: "tr",
  cze: "cs", ces: "cs", czech: "cs", gre: "el", ell: "el", greek: "el", rum: "ro", ron: "ro",
  swe: "sv", swedish: "sv", fin: "fi", finnish: "fi", nor: "no", norwegian: "no", dan: "da", danish: "da",
  hun: "hu", hungarian: "hu", ara: "ar", arabic: "ar", heb: "he", hebrew: "he",
};

const subtitleFlags: Record<string, string> = {
  forced: "только надписи",
  signs: "только надписи",
  sdh: "для слабослышащих",
  cc: "для слабослышащих",
  full: "полные",
};

/** Languages listed first in the subtitle menu. */
const preferredLanguages = ["ru", "en"];
/** With no video name to strip, only the tail of the file name is searched for a language. */
const tailTokenCount = 2;

export interface SubtitleLabel {
  /** Language name, or the file name when the language is not recognised. */
  label: string;
  /** Flags and format, e.g. "только надписи · SRT". */
  detail: string;
  languageCode: string | null;
}

function toLanguageCode(token: string): string | null {
  if (languageAliases[token]) return languageAliases[token];
  if (!/^[a-z]{2,3}$/.test(token)) return null;
  try {
    return languageNames.of(token) ? token : null;
  } catch {
    return null;
  }
}

/** Turns "Movie.ru.forced.srt" into "Русский" with the detail "только надписи · SRT". */
export function describeSubtitleFile(fileName: string, videoFileName: string): SubtitleLabel {
  const extension = fileName.split(".").pop() ?? "";
  const stem = fileName.slice(0, fileName.length - extension.length - 1);
  const videoStem = videoFileName.replace(/\.[^.]+$/, "");

  const sharesVideoName = stem.toLowerCase().startsWith(videoStem.toLowerCase());
  const rest = sharesVideoName ? stem.slice(videoStem.length) : stem;
  const allTokens = rest.toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(Boolean);
  const tokens = sharesVideoName ? allTokens : allTokens.slice(-tailTokenCount);

  let languageCode: string | null = null;
  const flags: string[] = [];
  for (const token of tokens) {
    if (subtitleFlags[token]) flags.push(subtitleFlags[token]);
    else languageCode ??= toLanguageCode(token);
  }

  const name = languageCode ? languageNames.of(languageCode) : undefined;
  return {
    label: name ? name.charAt(0).toUpperCase() + name.slice(1) : stem,
    detail: [...new Set(flags), extension.toUpperCase()].join(" · "),
    languageCode: name ? languageCode : null,
  };
}

function languageOrder(label: SubtitleLabel): number {
  if (!label.languageCode) return preferredLanguages.length + 1;
  const index = preferredLanguages.indexOf(label.languageCode);
  return index >= 0 ? index : preferredLanguages.length;
}

export function compareSubtitleLabels(a: SubtitleLabel, b: SubtitleLabel): number {
  return languageOrder(a) - languageOrder(b) || a.label.localeCompare(b.label, "ru");
}
