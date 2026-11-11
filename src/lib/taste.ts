import type { Dismissal } from "./account";
import type { MediaItem, MediaType, TitleTaste } from "./tmdb";
import type { TitleRef, TrackEntry, WatchStatus } from "../state/library";

const msPerDay = 86_400_000;

const neutralRating = 5.5;
const ratingSpan = 4.5;
const statusWeights: Record<WatchStatus, number> = {
  completed: 0.55,
  watching: 0.45,
  planned: 0.25,
  onHold: 0.1,
  dropped: -0.5,
};
const dismissedWeight = -0.2;
const oldestSignalShare = 0.4;
const tasteHalfLifeDays = 240;
const weakestSignal = 0.08;

export interface TasteSignal {
  title: TitleRef;
  weight: number;
  rated: boolean;
  status: WatchStatus | null;
}

export interface PersonAffinity {
  id: number;
  name: string;
  role: "director" | "cast";
  affinity: number;
  titles: number;
}

export interface TasteProfile {
  genres: Map<number, number>;
  people: PersonAffinity[];
  types: Record<MediaType, number>;
  anime: number;
  languages: Map<string, number>;
}

export interface Recommendation {
  item: MediaItem;
  score: number;
  because: TitleRef | null;
}

const combinedGenres: Record<number, number[]> = {
  10759: [28, 12],
  10765: [878, 14],
  10768: [10752],
};

export function canonicalGenres(genreIds: number[]): number[] {
  return [...new Set(genreIds.flatMap((id) => combinedGenres[id] ?? [id]))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function key(title: Pick<TitleRef, "type" | "id">): string {
  return `${title.type}:${title.id}`;
}

function faded(weight: number, updatedAt: number, now: number): number {
  const ageDays = Math.max(0, now - updatedAt) / msPerDay;
  return weight * (oldestSignalShare + (1 - oldestSignalShare) * 0.5 ** (ageDays / tasteHalfLifeDays));
}

export function tasteSignals(tracked: Record<string, TrackEntry>, now: number): TasteSignal[] {
  const signals: TasteSignal[] = [];
  for (const entry of Object.values(tracked)) {
    const stated =
      entry.rating !== null
        ? clamp((entry.rating - neutralRating) / ratingSpan, -1, 1)
        : entry.status
          ? statusWeights[entry.status]
          : 0;
    const weight = faded(stated, entry.updatedAt, now);
    if (Math.abs(weight) < weakestSignal) continue;
    const { type, id, title, poster, backdrop, year } = entry;
    signals.push({
      title: { type, id, title, poster, backdrop, year },
      weight,
      rated: entry.rating !== null,
      status: entry.status,
    });
  }
  return signals.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

export function dismissalSignals(
  dismissed: Record<string, Dismissal>,
  tracked: Record<string, TrackEntry>,
  now: number,
): TasteSignal[] {
  return Object.values(dismissed)
    .filter((dismissal) => !(key(dismissal) in tracked))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ updatedAt, ...title }) => ({ title, weight: faded(dismissedWeight, updatedAt, now), rated: false, status: null }))
    .filter((signal) => Math.abs(signal.weight) >= weakestSignal);
}

export function buildProfile(seeds: { signal: TasteSignal; source: TitleTaste }[]): TasteProfile {
  const genreSums = new Map<number, number>();
  const people = new Map<number, PersonAffinity>();
  const languages = new Map<string, number>();
  const types: Record<MediaType, number> = { movie: 0, tv: 0 };
  let anime = 0;
  let totalWeight = 0;
  let positiveWeight = 0;

  for (const { signal, source } of seeds) {
    const { weight } = signal;
    totalWeight += Math.abs(weight);
    for (const genre of canonicalGenres(source.item.genreIds)) {
      genreSums.set(genre, (genreSums.get(genre) ?? 0) + weight);
    }
    if (weight <= 0) continue;

    positiveWeight += weight;
    types[source.item.type] += weight;
    if (source.item.isAnime) anime += weight;
    languages.set(source.item.language, (languages.get(source.item.language) ?? 0) + weight);
    for (const person of source.people) {
      const known = people.get(person.id) ?? { ...person, affinity: 0, titles: 0 };
      known.affinity += person.role === "director" ? weight : weight / 2;
      known.titles += 1;
      people.set(person.id, known);
    }
  }

  const share = (value: number) => (positiveWeight > 0 ? value / positiveWeight : 0);
  return {
    genres: new Map([...genreSums].map(([genre, sum]) => [genre, totalWeight > 0 ? sum / totalWeight : 0])),
    people: [...people.values()].sort((a, b) => b.affinity - a.affinity),
    types: { movie: share(types.movie), tv: share(types.tv) },
    anime: share(anime),
    languages: new Map([...languages].map(([language, sum]) => [language, share(sum)])),
  };
}

export function favoriteGenres(profile: TasteProfile, limit: number): number[] {
  return [...profile.genres]
    .filter(([, affinity]) => affinity > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([genre]) => genre);
}

const partWeights = { similarity: 0.45, genres: 0.25, quality: 0.15, kind: 0.08, language: 0.07 };
const similarityHalfRank = 6;
const looseSimilarityShare = 0.5;
const trustedVoteCount = 300;
const catalogAverageRating = 6.5;
const ratingSpread = 1.5;
const fewestVotes = 30;
const lowestWeightedRating = 5.6;
const animeStrangerShare = 0.05;
const animeStrangerPenalty = 0.25;
const repeatedSourcePenalty = 0.07;
const repeatedGenrePenalty = 0.03;

export function weightedRating(item: MediaItem): number {
  const votes = item.voteCount;
  return (votes * item.rating + trustedVoteCount * catalogAverageRating) / (votes + trustedVoteCount);
}

export function bestRated(items: MediaItem[], lowestRating: number = lowestWeightedRating): MediaItem[] {
  return items
    .filter((item) => item.voteCount >= fewestVotes && weightedRating(item) >= lowestRating)
    .sort((a, b) => weightedRating(b) - weightedRating(a));
}

export function rankCandidates(
  seeds: { signal: TasteSignal; source: TitleTaste }[],
  extra: MediaItem[],
  profile: TasteProfile,
  excluded: ReadonlySet<string>,
  limit: number,
): Recommendation[] {
  interface Candidate {
    item: MediaItem;
    similarity: number;
    because: TitleRef | null;
    strongestLink: number;
  }
  const candidates = new Map<string, Candidate>();
  const candidate = (item: MediaItem): Candidate => {
    const known = candidates.get(key(item));
    if (known) return known;
    const fresh: Candidate = { item, similarity: 0, because: null, strongestLink: 0 };
    candidates.set(key(item), fresh);
    return fresh;
  };

  for (const { signal, source } of seeds) {
    const lists: [MediaItem[], number][] = [
      [source.recommendations, 1],
      [source.similar, looseSimilarityShare],
    ];
    for (const [list, share] of lists) {
      list.forEach((item, rank) => {
        const link = signal.weight * share * (similarityHalfRank / (similarityHalfRank + rank));
        const entry = candidate(item);
        entry.similarity += link;
        if (link > entry.strongestLink) {
          entry.strongestLink = link;
          entry.because = signal.title;
        }
      });
    }
  }
  for (const item of extra) candidate(item);

  const strongestSimilarity = Math.max(0, ...[...candidates.values()].map((entry) => entry.similarity));
  const strongestGenre = Math.max(0, ...[...profile.genres.values()].map(Math.abs));
  const favouriteLanguageShare = Math.max(0, ...profile.languages.values());

  const scored: Recommendation[] = [];
  for (const entry of candidates.values()) {
    const { item } = entry;
    if (excluded.has(key(item)) || !item.poster || item.voteCount < fewestVotes) continue;
    const rating = weightedRating(item);
    if (rating < lowestWeightedRating) continue;

    const genres = canonicalGenres(item.genreIds);
    const genreMatch =
      genres.length > 0 && strongestGenre > 0
        ? genres.reduce((sum, genre) => sum + (profile.genres.get(genre) ?? 0), 0) / genres.length / strongestGenre
        : 0;
    const languageMatch =
      favouriteLanguageShare > 0 ? (profile.languages.get(item.language) ?? 0) / favouriteLanguageShare : 0;

    let score =
      partWeights.similarity * (strongestSimilarity > 0 ? clamp(entry.similarity / strongestSimilarity, -1, 1) : 0) +
      partWeights.genres * clamp(genreMatch, -1, 1) +
      partWeights.quality * clamp((rating - catalogAverageRating) / ratingSpread, -1, 1) +
      partWeights.kind * profile.types[item.type] +
      partWeights.language * languageMatch;
    if (item.isAnime && profile.anime < animeStrangerShare) score -= animeStrangerPenalty;

    scored.push({ item, score, because: entry.similarity > 0 ? entry.because : null });
  }

  const picked: Recommendation[] = [];
  const perSource = new Map<string, number>();
  const perGenre = new Map<number, number>();
  const remaining = scored.sort((a, b) => b.score - a.score);
  while (picked.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    remaining.forEach((entry, index) => {
      const source = entry.because ? (perSource.get(key(entry.because)) ?? 0) : 0;
      const genre = perGenre.get(canonicalGenres(entry.item.genreIds)[0] ?? -1) ?? 0;
      const adjusted = entry.score - source * repeatedSourcePenalty - genre * repeatedGenrePenalty;
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestIndex = index;
      }
    });
    const [choice] = remaining.splice(bestIndex, 1);
    picked.push(choice);
    if (choice.because) perSource.set(key(choice.because), (perSource.get(key(choice.because)) ?? 0) + 1);
    const leadingGenre = canonicalGenres(choice.item.genreIds)[0];
    if (leadingGenre !== undefined) perGenre.set(leadingGenre, (perGenre.get(leadingGenre) ?? 0) + 1);
  }
  return picked;
}
