export const appLanguages = ["en", "uk", "ru"] as const;
export type AppLanguage = (typeof appLanguages)[number];

export function isAppLanguage(code: string): code is AppLanguage {
  return (appLanguages as readonly string[]).includes(code);
}

const twoLetterCodes: Record<string, string> = {
  rus: "ru", ukr: "uk", eng: "en", jpn: "ja", fre: "fr", fra: "fr", ger: "de", deu: "de", spa: "es", ita: "it",
  por: "pt", pol: "pl", kor: "ko", chi: "zh", zho: "zh", yue: "zh", cmn: "zh", tur: "tr", swe: "sv", nor: "no",
  nob: "no", nno: "no", dan: "da", fin: "fi", dut: "nl", nld: "nl", cze: "cs", ces: "cs", hun: "hu", heb: "he",
  ara: "ar", hin: "hi", bel: "be", kaz: "kk", tha: "th", vie: "vi", ind: "id", may: "ms", msa: "ms", per: "fa",
  fas: "fa", gre: "el", ell: "el", rum: "ro", ron: "ro", mol: "ro", bul: "bg", srp: "sr", hrv: "hr", bos: "bs",
  slv: "sl", slo: "sk", slk: "sk", lit: "lt", lav: "lv", est: "et", geo: "ka", kat: "ka", arm: "hy", hye: "hy",
  aze: "az", uzb: "uz", ice: "is", isl: "is", gle: "ga", wel: "cy", cym: "cy", baq: "eu", eus: "eu", cat: "ca",
  glg: "gl", tgl: "tl", fil: "tl", ben: "bn", tam: "ta", tel: "te", urd: "ur", mal: "ml", kan: "kn", mar: "mr",
  pan: "pa", guj: "gu", sin: "si", khm: "km", lao: "lo", mon: "mn", nep: "ne", mac: "mk", mkd: "mk", alb: "sq",
  sqi: "sq", afr: "af", swa: "sw", amh: "am", yid: "yi", lat: "la", epo: "eo", ltz: "lb", mlt: "mt", kur: "ku",
  pus: "ps", tat: "tt", tgk: "tg", tuk: "tk", kir: "ky", bur: "my", mya: "my", tib: "bo", bod: "bo", som: "so",
  hau: "ha", yor: "yo", ibo: "ig", zul: "zu", xho: "xh", jav: "jv", sun: "su", fao: "fo", bre: "br", oci: "oc",
};

const sameLanguage: Record<string, string> = { cn: "zh", iw: "he", in: "id", ji: "yi", nb: "no", nn: "no", mo: "ro" };

export function threeLetterCodes(code: string): string[] {
  return Object.entries(twoLetterCodes)
    .filter(([, two]) => two === code)
    .map(([three]) => three);
}

export function languageCode(raw: string | null | undefined): string {
  const code = (raw ?? "").trim().toLowerCase().split(/[-_]/)[0];
  if (code.length === 2) return sameLanguage[code] ?? code;
  return twoLetterCodes[code] ?? "";
}

export function languageName(code: string, locale: string): string {
  if (!code) return "";
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
