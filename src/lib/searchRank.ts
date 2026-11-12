import type { FoundPerson, MediaItem } from "./tmdb";

export const noMatch = 4;
const rankedTiers = 3;
const leadingArticle = /^(the|a|an)\s+/;

function words(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tierOf(query: string, name: string): number {
  const full = words(name);
  if (!query || !full) return noMatch;
  const bare = full.replace(leadingArticle, "");
  if (full === query || bare === query) return 0;
  if (full.startsWith(query) || bare.startsWith(query)) return 1;
  if (full.split(" ").some((word) => word.startsWith(query))) return 2;
  if (full.replace(/ /g, "").includes(query.replace(/ /g, ""))) return 3;
  return noMatch;
}

export function matchTier(query: string, names: string[]): number {
  const wanted = words(query);
  return Math.min(noMatch, ...names.map((name) => tierOf(wanted, name)));
}

function fame(item: MediaItem): number {
  return Math.log10(1 + item.voteCount) + Math.log10(1 + (item.popularity ?? 0)) / 2;
}

export function rankTitles(query: string, items: MediaItem[]): MediaItem[] {
  return items
    .map((item, index) => ({ item, index, tier: matchTier(query, [item.title, item.originalTitle]) }))
    .sort((a, b) => {
      const tierA = Math.min(a.tier, rankedTiers);
      const tierB = Math.min(b.tier, rankedTiers);
      if (tierA !== tierB) return tierA - tierB;
      if (tierA < rankedTiers) return fame(b.item) - fame(a.item) || a.index - b.index;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

export function bestTitleTier(query: string, items: MediaItem[]): number {
  return Math.min(noMatch, ...items.map((item) => matchTier(query, [item.title, item.originalTitle])));
}

export function bestPersonTier(query: string, people: FoundPerson[]): number {
  return Math.min(noMatch, ...people.map((person) => matchTier(query, [person.name])));
}
