import { languageName, type AppLanguage } from "../lib/languages";
import { LanguageFlag } from "./LanguageFlag";

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

export function LanguageFlags({ available, locale }: { available: readonly string[]; locale: string }) {
  const codes = [...new Set(available.filter(Boolean))];
  if (codes.length === 0) return null;
  return (
    <span className="language-flags">
      {codes.map((code) => {
        const name = languageName(code, locale);
        return (
          <span key={code} className="language-flags__flag" title={`${name.charAt(0).toUpperCase()}${name.slice(1)}`}>
            <LanguageFlag code={code} />
          </span>
        );
      })}
    </span>
  );
}
