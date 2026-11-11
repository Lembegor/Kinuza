// Shown once, before anything else: the language the app will speak.

import { fallbackLanguage, type MessageKey } from "../lib/i18n";
import { appLanguages, isAppLanguage, languageCode, type AppLanguage } from "../lib/languages";
import { en } from "../locales/en";
import { ru } from "../locales/ru";
import { uk } from "../locales/uk";
import { useSettings } from "../state/settings";
import { FlagArt } from "./LanguageFlags";

/** Each language under its own name, as its speakers write it. */
const ownNames: Record<AppLanguage, string> = { en: "English", uk: "Українська", ru: "Русский" };
const dictionaries = { en, uk, ru };

/** The language on offer that the system itself speaks; it is the one a press of Enter chooses. */
function likelyLanguage(): AppLanguage {
  const spoken = navigator.languages.map(languageCode).find(isAppLanguage);
  return spoken ?? fallbackLanguage;
}

/** `onChosen` is called after the choice is stored, whichever language it was. */
export function LanguagePicker({ onChosen }: { onChosen?: () => void }) {
  const patch = useSettings((state) => state.patch);
  // Set when the user has come back to this step to change their mind.
  const current = useSettings((state) => state.language);
  const focused = current || likelyLanguage();
  // Nothing is chosen yet, so the heading is given in every language on offer.
  const inEvery = (key: MessageKey) => appLanguages.map((language) => dictionaries[language][key]);

  return (
    <div className="language-picker">
      <div className="language-picker__card">
        <h1>
          {inEvery("language.choose.title").map((text) => (
            <span key={text}>{text}</span>
          ))}
        </h1>
        <div className="language-picker__options">
          {appLanguages.map((language) => (
            <button
              key={language}
              autoFocus={language === focused}
              aria-current={language === current}
              onClick={() => {
                patch({ language });
                onChosen?.();
              }}
            >
              <span className="language-picker__flag">
                <FlagArt language={language} />
              </span>
              {ownNames[language]}
            </button>
          ))}
        </div>
        <p>{inEvery("language.choose.note").join(" · ")}</p>
      </div>
    </div>
  );
}

/** A plain select for the settings page. */
export function LanguageSelect() {
  const language = useSettings((state) => state.language);
  const patch = useSettings((state) => state.patch);
  return (
    <select className="select select--large" value={language || fallbackLanguage} onChange={(event) => patch({ language: event.target.value as AppLanguage })}>
      {appLanguages.map((code) => (
        <option key={code} value={code}>
          {ownNames[code]}
        </option>
      ))}
    </select>
  );
}
