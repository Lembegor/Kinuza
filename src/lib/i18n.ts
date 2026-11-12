import { en } from "../locales/en";
import { ru } from "../locales/ru";
import { uk } from "../locales/uk";
import { useSettings } from "../state/settings";
import type { AppLanguage } from "./languages";

export type MessageKey = keyof typeof ru;
export type Messages = Record<MessageKey, string>;
export type MessageParams = Record<string, string | number>;

const dictionaries: Record<AppLanguage, Messages> = { en, uk, ru };
export const fallbackLanguage: AppLanguage = "en";

const locales: Record<AppLanguage, string> = { en: "en-US", uk: "uk-UA", ru: "ru-RU" };

export function currentLanguage(): AppLanguage {
  return useSettings.getState().language || fallbackLanguage;
}

export function currentLocale(): string {
  return locales[currentLanguage()];
}

function fill(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

function translate(language: AppLanguage, key: MessageKey, params?: MessageParams): string {
  return fill(dictionaries[language][key] ?? en[key] ?? ru[key] ?? key, params);
}

export function t(key: MessageKey, params?: MessageParams): string {
  return translate(currentLanguage(), key, params);
}

export function tn(key: string, count: number, params?: MessageParams): string {
  const language = currentLanguage();
  const form = new Intl.PluralRules(locales[language]).select(count);
  const dictionary = dictionaries[language] as Record<string, string>;
  const english = en as Record<string, string>;
  const template = dictionary[`${key}.${form}`] ?? dictionary[`${key}.other`] ?? english[`${key}.other`] ?? key;
  return fill(template, { count, ...params });
}

export function useT(): { t: typeof t; tn: typeof tn; language: AppLanguage; locale: string } {
  const language = useSettings((state) => state.language) || fallbackLanguage;
  return { t, tn, language, locale: locales[language] };
}
