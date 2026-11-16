import type { TitlePreferences } from "./account";
import { useSettings } from "../state/settings";

export interface AudioWish {
  language: string;
  original: boolean;
  author: string;
  kind: string;
  fromTitle: boolean;
}

export function audioWish(preferences: TitlePreferences | undefined, originalLanguage: string): AudioWish | null {
  if (preferences?.audioLanguage || preferences?.audioAuthor || preferences?.audioTitle) {
    const language = preferences.audioLanguage ?? "";
    return { language, original: Boolean(language) && language === originalLanguage, author: preferences.audioAuthor ?? "", kind: preferences.audioKind ?? "", fromTitle: true };
  }
  const { lastVoice, audioLanguage } = useSettings.getState();
  if (lastVoice?.original) return { language: originalLanguage, original: true, author: "", kind: "", fromTitle: false };
  if (lastVoice?.language) return { language: lastVoice.language, original: lastVoice.language === originalLanguage, author: lastVoice.author, kind: lastVoice.kind, fromTitle: false };
  if (audioLanguage) return { language: audioLanguage, original: audioLanguage === originalLanguage, author: "", kind: "", fromTitle: false };
  return null;
}

export function wantedAudioLanguage(preferences: TitlePreferences | undefined, originalLanguage: string): string {
  const wish = audioWish(preferences, originalLanguage);
  return wish ? wish.language : "";
}

export function subtitleWish(preferences: TitlePreferences | undefined): { language: string; signs: boolean } {
  if (preferences?.subtitleLanguage) return { language: preferences.subtitleLanguage, signs: preferences.subtitleSigns ?? false };
  const { lastSubtitles, subtitleLanguage } = useSettings.getState();
  if (lastSubtitles?.language) return lastSubtitles;
  return { language: subtitleLanguage, signs: false };
}
