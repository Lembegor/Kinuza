// Language codes as files, the catalog and the app each write them, brought to one form.

/** Languages the app's interface is available in, in the order they are offered. */
export const appLanguages = ["en", "uk", "ru"] as const;
export type AppLanguage = (typeof appLanguages)[number];

export function isAppLanguage(code: string): code is AppLanguage {
  return (appLanguages as readonly string[]).includes(code);
}

/** Three-letter codes found in video files (ISO 639-2, both variants) to the two-letter ones used elsewhere. */
const twoLetterCodes: Record<string, string> = {
  rus: "ru",
  ukr: "uk",
  eng: "en",
  jpn: "ja",
  fre: "fr",
  fra: "fr",
  ger: "de",
  deu: "de",
  spa: "es",
  ita: "it",
  por: "pt",
  pol: "pl",
  kor: "ko",
  chi: "zh",
  zho: "zh",
  tur: "tr",
  swe: "sv",
  nor: "no",
  dan: "da",
  fin: "fi",
  dut: "nl",
  nld: "nl",
  cze: "cs",
  ces: "cs",
  hun: "hu",
  heb: "he",
  ara: "ar",
  hin: "hi",
  bel: "be",
  kaz: "kk",
};

/** A two-letter code for whatever a file or the catalog calls the language; empty when it is unknown. */
export function languageCode(raw: string | null | undefined): string {
  const code = (raw ?? "").trim().toLowerCase().split(/[-_]/)[0];
  if (code.length === 2) return code;
  return twoLetterCodes[code] ?? "";
}

/** The language's name in the given interface language, e.g. "английский"; the code itself if it has no name. */
export function languageName(code: string, locale: string): string {
  if (!code) return "";
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
