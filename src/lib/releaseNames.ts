import { t } from "./i18n";
import { languageName } from "./languages";
import { qualityRank, type VoiceKind } from "./parse";
import type { ReleaseVoice } from "./trackNames";

export type PictureTone = "top" | "high" | "mid" | "low" | "bad";
export type SourceKind = "remux" | "disc" | "web" | "tv" | "hdrip" | "dvd" | "camera";

export interface VoiceGroup {
  code: string;
  kinds: string;
  authors: string;
}

const sourceKinds: [RegExp, SourceKind][] = [
  [/telesync|telecine|cam-?rip|\bcam\b|\bts\b/i, "camera"],
  [/remux/i, "remux"],
  [/blu-?ray|bd-?rip|br-?rip/i, "disc"],
  [/web/i, "web"],
  [/hdtv|sat-?rip|tv-?rip/i, "tv"],
  [/dvd/i, "dvd"],
  [/hd-?rip/i, "hdrip"],
];
const kindOrder: VoiceKind[] = ["dub", "mvo", "dvo", "avo", "vo", "original"];
const shownAuthors = 3;
export const pictureMarks = ["Dolby Vision", "HDR"];

export function sourceKind(text: string): SourceKind | null {
  return sourceKinds.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

export function sourceName(text: string): { name: string; note: string } {
  const kind = sourceKind(text);
  if (!kind) return { name: text.trim(), note: "" };
  const name = kind === "web" && /web-?rip/i.test(text) ? "WEBRip" : t(`release.source.${kind}`);
  return { name, note: t(`release.source.${kind}.note`) };
}

export function pictureBadge(resolution: string, source: string): { label: string; tone: PictureTone } {
  if (sourceKind(source) === "camera") return { label: t("release.badge.camera"), tone: "bad" };
  const rank = qualityRank(resolution);
  if (rank >= 2000) return { label: "4K", tone: "top" };
  if (rank >= 1000) return { label: `${rank}p`, tone: "high" };
  if (rank >= 700) return { label: `${rank}p`, tone: "mid" };
  return { label: "SD", tone: "low" };
}

export function voiceGroups(voices: ReleaseVoice[], locale: string): VoiceGroup[] {
  const codes = [...new Set(voices.map((voice) => voice.language))];
  const dubbedFirst = (code: string) => (voices.some((voice) => voice.language === code && voice.kind !== "original") ? 0 : 1);
  return codes
    .sort((a, b) => dubbedFirst(a) - dubbedFirst(b))
    .map((code) => {
      const own = voices.filter((voice) => voice.language === code);
      const kinds = kindOrder
        .filter((kind) => own.some((voice) => voice.kind === kind))
        .map((kind, index) => (index === 0 ? t(`tracker.voice.${kind}`) : t(`tracker.voice.${kind}`).toLocaleLowerCase(locale)));
      const authors = [...new Set(own.map((voice) => voice.author).filter(Boolean))];
      const named = authors.slice(0, shownAuthors).join(", ") + (authors.length > shownAuthors ? ` +${authors.length - shownAuthors}` : "");
      const language = languageName(code, locale);
      return {
        code,
        kinds: kinds.join(", ") || (named ? "" : language.charAt(0).toLocaleUpperCase(locale) + language.slice(1)),
        authors: named,
      };
    })
    .filter((group) => group.kinds || group.authors);
}
