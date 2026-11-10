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
