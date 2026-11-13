import type { AudioTrackInfo, SubtitleTrackInfo } from "./backend";
import { t } from "./i18n";
import { languageCode, languageName } from "./languages";
import { languagesNamedIn, type TrackerRelease, type VoiceKind } from "./parse";
import type { SubtitleLabel } from "./subtitles";

export type SoundKind = VoiceKind | "commentary";

export interface TrackFace {
  code: string;
  name: string;
  note: string;
}

export interface ReleaseVoice {
  language: string;
  kind: VoiceKind | null;
  count: number | null;
  author: string;
}

export interface TrackGuess {
  code?: string;
  kind?: SoundKind | null;
  author?: string;
  origin?: string;
}

const kindWords: [RegExp, SoundKind][] = [
  [/comment|коммент/i, "commentary"],
  [/\bdub|дубл/i, "dub"],
  [/\bmvo\b|многоголос/i, "mvo"],
  [/\bdvo\b|двухголос|двуголос/i, "dvo"],
  [/\bavo\b|авторск/i, "avo"],
  [/\bvo\b|одноголос/i, "vo"],
  [/\borig|оригинал/i, "original"],
];
const leadingKind =
  /^(dubbed|dub|дубляж|дублированн[а-яё]*|mvo|dvo|avo|vo|original|orig|оригинал[а-яё]*|многоголос[а-яё]*|двухголос[а-яё]*|двуголос[а-яё]*|одноголос[а-яё]*|авторск[а-яё]*)(?![a-zа-яё0-9])(\s+(озвучка|перевод|закадровый|закадровая))*[\s:|,.–—-]*/i;
const languageWords = /\b(russian|rus|ru|ukrainian|ukr|ua|english|eng|en|japanese|jap|jpn)\b|(рус|укр|англ|япон)[а-яёії]*/gi;
const technicalTitle = /^((e-?)?ac-?3|dts|aac|flac|truehd|atmos|stereo|mono|surround|dolby|digital|plus|pcm|lpcm|opus|mp3|hd|ma|es|ex|kbps|kb\/s|ch|\d+|[\s.,/()+-])+$/i;
const kindMarks = /[[(]?\b(mvo|dvo|avo|vo|dub|dubbed)\b[\])]?/gi;
const signsTitle = /forced|форсир|надпис|signs/i;
const plainSubtitleTitle = /^(full|полные|forced|форсированные|signs|надписи|subs?|subtitles?|субтитры|sdh|\s|[.,/()+&-])+$/i;
const folderNoise = /\b(sounds?|audio|subs?|subtitles?|voices?)\b|звук|озвучк[аи]|дорожки|субтитры|сабы/gi;

function capitalized(text: string, locale: string): string {
  return text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : "";
}

function languageTitle(code: string, locale: string): string {
  return capitalized(languageName(code, locale), locale) || t("player.track.noLanguage");
}

function tidy(text: string): string {
  return text
    .replace(/\s{2,}/g, " ")
    .replace(/(\s*,\s*)+/g, ", ")
    .replace(/^[\s,;:|+&)\]._–—-]+|[\s,;:|+&([._–—-]+$/g, "")
    .trim();
}

function slashed(path: string): string[] {
  return path.split(/[\\/]/);
}

function unwrapped(text: string): string {
  const inner = /^[[(]([^()[\]]*)[\])]$/.exec(text)?.[1];
  return inner === undefined ? text : tidy(inner);
}

export function soundKindIn(text: string): SoundKind | null {
  return kindWords.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function authorIn(title: string): string {
  const cleaned = unwrapped(tidy(title.replace(leadingKind, "").replace(kindMarks, "")));
  if (technicalTitle.test(cleaned)) return "";
  return tidy(cleaned.replace(languageWords, "")) ? cleaned : "";
}

const channelNames: Record<string, string> = { mono: "1.0", stereo: "2.0" };
const subtitleFormats: Record<string, string> = { subrip: "SRT", srt: "SRT", ass: "ASS", ssa: "SSA", webvtt: "VTT", mov_text: "TX3G" };

const channelCounts: Record<number, string> = { 1: "1.0", 2: "2.0", 3: "2.1", 4: "4.0", 5: "5.0", 6: "5.1", 7: "6.1", 8: "7.1" };
const codecLabels: Record<string, string> = {
  ac3: "AC3",
  eac3: "E-AC3",
  dts: "DTS",
  truehd: "TrueHD",
  flac: "FLAC",
  aac: "AAC",
  opus: "Opus",
  mp3: "MP3",
  mp2: "MP2",
  vorbis: "Vorbis",
  alac: "ALAC",
};
const codecNames: Record<string, string> = {
  ac3: "Dolby Digital",
  eac3: "Dolby Digital Plus",
  dts: "DTS",
  truehd: "Dolby TrueHD",
  flac: "FLAC",
  aac: "AAC",
  opus: "Opus",
  mp3: "MP3",
  alac: "Apple Lossless",
};
const losslessCodec = /^(flac|truehd|mlp|alac|pcm)/;

export function channelLayout(raw: string): string {
  const text = raw.replace(/[(].*[)]/, "").trim().toLowerCase();
  if (channelNames[text]) return channelNames[text];
  const count = /^(?:unknown)?(\d+)(?:ch)?$/.exec(text)?.[1];
  if (count) return channelCounts[Number(count)] ?? `${count}ch`;
  return text;
}

export function codecLabel(codec: string): string {
  const name = codec.toLowerCase();
  return name.startsWith("pcm") ? "PCM" : (codecLabels[name] ?? codec.toUpperCase());
}

export function codecName(codec: string): string {
  const name = codec.toLowerCase();
  const full = name.startsWith("pcm") ? "PCM" : (codecNames[name] ?? codec.toUpperCase());
  return losslessCodec.test(name) ? `${full} · ${t("player.track.lossless")}` : full;
}

function soundFormat(track: AudioTrackInfo): string {
  return [codecLabel(track.codec), channelLayout(track.channels)].filter(Boolean).join(" ");
}

function subtitleFormat(track: SubtitleTrackInfo): string {
  return subtitleFormats[track.codec.toLowerCase()] ?? track.codec.toUpperCase();
}

function kindTitle(kind: SoundKind | null, count?: number | null): string {
  if (!kind) return "";
  const name = t(`voice.kind.${kind}`);
  return count && count > 1 ? `${name} ×${count}` : name;
}

export interface VoiceLike {
  code: string;
  kind: SoundKind | null;
  author: string;
}

export interface SoundInfo extends VoiceLike {
  name: string;
  codec: string;
  codecFull: string;
  layout: string;
  lossless: boolean;
}

export function soundInfo(track: AudioTrackInfo, locale: string, originalLanguage: string | undefined, guess: TrackGuess = {}): SoundInfo {
  const named = languageCode(track.language) || languagesNamedIn(track.title)[0] || "";
  const bare = !named && !track.title.trim();
  const code = named || guess.code || "";
  const told = track.isOriginal ? "original" : soundKindIn(track.title);
  const kind = told ?? (bare ? (guess.kind ?? null) : null) ?? (code && code === originalLanguage ? "original" : null);
  return {
    code,
    kind,
    author: authorIn(track.title) || guess.author || "",
    name: [languageTitle(code, locale), kindTitle(kind)].filter(Boolean).join(" · "),
    codec: codecLabel(track.codec),
    codecFull: codecName(track.codec),
    layout: channelLayout(track.channels),
    lossless: losslessCodec.test(track.codec.toLowerCase()),
  };
}

export function voicedBy(voice: VoiceLike): string {
  if (!voice.author) return "";
  return voice.kind === "original" || voice.kind === "commentary" ? voice.author : t("player.track.voicedBy", { name: voice.author });
}

export function audioFace(track: AudioTrackInfo, locale: string, originalLanguage: string | undefined, guess: TrackGuess = {}): TrackFace {
  const info = soundInfo(track, locale, originalLanguage, guess);
  return {
    code: info.code,
    name: info.name,
    note: [voicedBy(info), soundFormat(track), guess.origin ?? ""].filter(Boolean).join(" · "),
  };
}

function plainAuthor(author: string): string {
  return author
    .toLowerCase()
    .replace(/studio|студия/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function sameVoice(first: VoiceLike, second: VoiceLike): boolean {
  if (first.code !== second.code) return false;
  const [one, other] = [plainAuthor(first.author), plainAuthor(second.author)];
  if (one || other) return one === other && (!first.kind || !second.kind || first.kind === second.kind);
  return first.kind === second.kind;
}

export function subtitleFace(track: SubtitleTrackInfo, locale: string, origin = ""): TrackFace {
  const code = languageCode(track.language) || languagesNamedIn(track.title)[0] || "";
  const signs = track.isForced || signsTitle.test(track.title);
  const title = tidy(track.title);
  const says = !title || plainSubtitleTitle.test(title) || !tidy(title.replace(languageWords, "")) ? "" : title;
  return {
    code,
    name: [languageTitle(code, locale), signs ? t("player.subtitles.signsOnly") : ""].filter(Boolean).join(" · "),
    note: [says, track.isText ? subtitleFormat(track) : t("player.subtitles.image"), origin].filter(Boolean).join(" · "),
  };
}

export function ownFolders(path: string, besidePath: string): string[] {
  const parts = slashed(path).slice(0, -1);
  const beside = slashed(besidePath).slice(0, -1);
  let shared = 0;
  while (shared < parts.length && shared < beside.length && parts[shared] === beside[shared]) shared++;
  return parts.slice(shared).map((folder) => folder.trim());
}

export function folderHint(path: string, besidePath: string): { code: string; author: string; kind: SoundKind | null } {
  const folders = ownFolders(path, besidePath);
  const named = folders.map((folder) => unwrapped(tidy(folder.replace(folderNoise, "").replace(languageWords, "")))).filter(Boolean);
  return {
    code: languagesNamedIn(folders.join(" "))[0] ?? "",
    author: named[named.length - 1] ?? "",
    kind: soundKindIn(folders.join(" ")),
  };
}

export function audioFileGuess(path: string, besidePath: string, guess: TrackGuess = {}): TrackGuess {
  const hint = folderHint(path, besidePath);
  const stem = (slashed(path).pop() ?? "").replace(/\.[^.]+$/, "");
  const besideStem = (slashed(besidePath).pop() ?? "").replace(/\.[^.]+$/, "");
  const rest = besideStem && stem.toLowerCase().startsWith(besideStem.toLowerCase()) ? tidy(stem.slice(besideStem.length)) : "";
  return {
    code: hint.code || languagesNamedIn(rest)[0] || guess.code || "",
    kind: hint.kind ?? soundKindIn(rest) ?? guess.kind ?? null,
    author: hint.author || (tidy(rest.replace(languageWords, "")) ? rest : "") || guess.author || "",
  };
}

export function audioFileFace(path: string, besidePath: string, locale: string, guess: TrackGuess = {}): TrackFace {
  const known = audioFileGuess(path, besidePath, guess);
  const extension = (/\.([^.]+)$/.exec(slashed(path).pop() ?? "")?.[1] ?? "").toUpperCase();
  return {
    code: known.code ?? "",
    name: [languageTitle(known.code ?? "", locale), kindTitle(known.kind ?? null)].filter(Boolean).join(" · "),
    note: [known.author ? t("player.track.voicedBy", { name: known.author }) : "", extension, t("player.track.separateFile")].filter(Boolean).join(" · "),
  };
}

export function subtitleFileFace(label: SubtitleLabel, path: string, besidePath: string, locale: string): TrackFace {
  const hint = folderHint(path, besidePath);
  const code = label.languageCode ?? hint.code;
  return {
    code,
    name: languageTitle(code, locale),
    note: [hint.author || (label.languageCode ? "" : label.label), label.detail, t("player.track.separateFile")].filter(Boolean).join(" · "),
  };
}

export function releaseVoices(release: TrackerRelease, originalLanguage: string | undefined): ReleaseVoice[] {
  const voices: ReleaseVoice[] = [];
  for (const track of release.audio) {
    const named = languagesNamedIn(track.raw)[0];
    const bracketed = /^[(].+[)]$/.test(track.raw.trim());
    const language = named ?? (track.kind === "original" ? (originalLanguage ?? "") : track.kind || bracketed ? "ru" : "");
    const author = unwrapped(tidy((track.kind ? track.detail : track.raw).replace(languageWords, "")));
    const kind = track.kind ?? (!author && language && language === originalLanguage ? "original" : null);
    if (!language && !author && !kind) continue;
    if (voices.some((voice) => voice.language === language && voice.kind === kind && voice.author === author)) continue;
    voices.push({ language, kind, count: track.count, author });
  }
  return voices;
}

export function voiceFace(voice: ReleaseVoice, locale: string): TrackFace {
  return {
    code: voice.language,
    name: [languageTitle(voice.language, locale), kindTitle(voice.kind, voice.count)].filter(Boolean).join(" · "),
    note: voice.author ? t("player.track.voicedBy", { name: voice.author }) : "",
  };
}

export function voicesSummary(voices: ReleaseVoice[], locale: string, ownLanguage: string, limit = 3): string {
  return voices
    .slice(0, limit)
    .map((voice, index) => {
      const kind = voice.kind ? t(`tracker.voice.${voice.kind}`) : "";
      const shown = voice.kind === "original" || voice.language !== ownLanguage || (!kind && !voice.author);
      const language = voice.language && shown ? languageName(voice.language, locale) : "";
      const lead = [index === 0 ? kind : kind.toLocaleLowerCase(locale), voice.author].filter(Boolean).join(" ");
      if (!lead) return index === 0 ? capitalized(language, locale) : language;
      return language ? `${lead} (${language})` : lead;
    })
    .filter(Boolean)
    .join(", ");
}
