// Interface texts in the app's languages. Russian is the source: its dictionary defines which
// keys exist, and the other languages must provide every one of them.

import { en } from "../locales/en";
import { ru } from "../locales/ru";
import { uk } from "../locales/uk";
import { useSettings } from "../state/settings";
import type { AppLanguage } from "./languages";

export type MessageKey = keyof typeof ru;
export type Messages = Record<MessageKey, string>;
/** Values for the `{name}` placeholders of a message. */
export type MessageParams = Record<string, string | number>;

const dictionaries: Record<AppLanguage, Messages> = { en, uk, ru };
/** Shown before the user has chosen: the first language on offer. */
export const fallbackLanguage: AppLanguage = "en";

/** BCP 47 tags for dates, numbers and the catalog. */
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
  return fill(dictionaries[language][key] ?? ru[key] ?? key, params);
}

/** A message in the current language. For code outside React; components use `useT` so they re-render on a language change. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(currentLanguage(), key, params);
}

/**
 * A message that depends on a number: "1 серия", "2 серии", "5 серий". `key` names a group of
 * messages `key.one`, `key.few`, `key.many`, `key.other`; a language provides the forms it has
 * (`other` always). `{count}` in the message is the number.
 */
export function tn(key: string, count: number, params?: MessageParams): string {
  const language = currentLanguage();
  const form = new Intl.PluralRules(locales[language]).select(count);
  const dictionary = dictionaries[language] as Record<string, string>;
  const template = dictionary[`${key}.${form}`] ?? dictionary[`${key}.other`] ?? key;
  return fill(template, { count, ...params });
}

/** `t` and `tn` bound to the interface language, for use inside components. */
export function useT(): { t: typeof t; tn: typeof tn; language: AppLanguage; locale: string } {
  // Subscribing is what makes the component re-render when the language changes.
  const language = useSettings((state) => state.language) || fallbackLanguage;
  return { t, tn, language, locale: locales[language] };
}
