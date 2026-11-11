// Three small flags that say at a glance which of the app's languages a release has.

import { useT } from "../lib/i18n";
import { appLanguages, languageName, type AppLanguage } from "../lib/languages";

export function FlagArt({ language }: { language: AppLanguage }) {
  if (language === "uk") {
    return (
      <svg viewBox="0 0 60 40" aria-hidden="true">
        <rect width="60" height="20" fill="#0057b7" />
        <rect y="20" width="60" height="20" fill="#ffd700" />
      </svg>
    );
  }
  if (language === "ru") {
    return (
      <svg viewBox="0 0 60 40" aria-hidden="true">
        <rect width="60" height="14" fill="#fff" />
        <rect y="13.5" width="60" height="13.5" fill="#0039a6" />
        <rect y="26.5" width="60" height="13.5" fill="#d52b1e" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 60 40" aria-hidden="true">
      <rect width="60" height="40" fill="#012169" />
      <path d="M0 0 60 40M60 0 0 40" stroke="#fff" strokeWidth="8" />
      <path d="M0 0 60 40M60 0 0 40" stroke="#c8102e" strokeWidth="3" />
      <path d="M30 0v40M0 20h60" stroke="#fff" strokeWidth="13" />
      <path d="M30 0v40M0 20h60" stroke="#c8102e" strokeWidth="7" />
    </svg>
  );
}

/**
 * `available` holds two-letter language codes. Every app language gets a flag: in colour when
 * the release has it, greyed out when it does not. `locale` is the language the tooltips are in.
 */
export function LanguageFlags({ available, locale }: { available: readonly string[]; locale: string }) {
  const { t } = useT();
  return (
    <span className="language-flags">
      {appLanguages.map((language) => {
        const present = available.includes(language);
        const name = languageName(language, locale);
        const capitalized = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
        return (
          <span
            key={language}
            className={`language-flags__flag ${present ? "is-present" : ""}`}
            title={present ? t("language.available", { language: capitalized }) : t("language.missing", { language: capitalized })}
          >
            <FlagArt language={language} />
          </span>
        );
      })}
    </span>
  );
}
