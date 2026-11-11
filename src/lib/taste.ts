// Turns what the user rated and watched into a taste profile and ranks catalog titles against it.
// Pure: no network and no storage, so the same code can later run on a server for an account.

import type { Dismissal } from "./account";
import type { MediaItem, MediaType, TitleTaste } from "./tmdb";
import type { TitleRef, TrackEntry, WatchStatus } from "../state/library";

const msPerDay = 86_400_000;

/** A personal rating maps onto -1..1 around this "neither liked nor disliked" point. */
const neutralRating = 5.5;
const ratingSpan = 4.5;
/** What a status says about a title that was not rated. */
const statusWeights: Record<WatchStatus, number> = {
  completed: 0.55,
  watching: 0.45,
  planned: 0.25,
  onHold: 0.1,
  dropped: -0.5,
};
/**
 * What "not interested" on a recommendation says. Milder than any low rating and than dropping a
 * title: the user turned down a suggestion, often without having seen the film at all.
 */
const dismissedWeight = -0.2;
/** Old signals fade to this share of their weight, halving every `tasteHalfLifeDays`. */
const oldestSignalShare = 0.4;
const tasteHalfLifeDays = 240;
/** Signals weaker than this say too little to act on. */
const weakestSignal = 0.08;

/** One title's vote in the taste profile. */
export interface TasteSignal {
  title: TitleRef;
  /** -1 (disliked) to 1 (loved), already faded by age. */
  weight: number;
  /** The user rated the title, as opposed to merely watching or planning it. */
  rated: boolean;
  status: WatchStatus | null;
}

export interface PersonAffinity {
  id: number;
  name: string;
  role: "director" | "cast";
  /** Sum of the weights of the liked titles the person worked on. */
  affinity: number;
  /** Number of liked titles the person worked on. */
  titles: number;
}

export interface TasteProfile {
  /** Canonical genre id to -1..1; positive means the user gravitates to the genre. */
  genres: Map<number, number>;
  people: PersonAffinity[];
  /** Share of the positive weight that went to each kind of title. */
  types: Record<MediaType, number>;
  /** Share of the positive weight that went to anime. */
  anime: number;
  /** Share of the positive weight per original language. */
  languages: Map<string, number>;
}

export interface Recommendation {
  item: MediaItem;
  score: number;
  /** The liked title that brought this one in; null when it came from genres or people alone. */
  because: TitleRef | null;
}

/** TV genres that bundle two film genres are counted as both, so taste carries across films and series. */
const combinedGenres: Record<number, number[]> = {
  10759: [28, 12], // Action & Adventure
  10765: [878, 14], // Sci-Fi & Fantasy
  10768: [10752], // War & Politics
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

/** What is left of a vote's weight at its age. */
function faded(weight: number, updatedAt: number, now: number): number {
  const ageDays = Math.max(0, now - updatedAt) / msPerDay;
  return weight * (oldestSignalShare + (1 - oldestSignalShare) * 0.5 ** (ageDays / tasteHalfLifeDays));
}

/** Reads a vote out of every tracked title, strongest first. */
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

/**
 * A mild vote against every recommendation the user dismissed, most recent first. A title the user
 * tracks all the same is left out: what they said about it there counts instead.
 */
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
      // A director shapes a film more than any one actor does.
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

/** Genres the user leans towards, strongest first. */
export function favoriteGenres(profile: TasteProfile, limit: number): number[] {
  return [...profile.genres]
    .filter(([, affinity]) => affinity > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([genre]) => genre);
}

// How much each part of the picture counts towards a candidate's score.
const partWeights = { similarity: 0.45, genres: 0.25, quality: 0.15, kind: 0.08, language: 0.07 };
/** A title this far down a "similar to X" list still counts for half as much as the first one. */
const similarityHalfRank = 6;
/** Catalog-wide "similar" lists are looser than the hand-tuned recommendations. */
const looseSimilarityShare = 0.5;
/** Ratings with few votes are pulled towards the catalog average until they have this many. */
const trustedVoteCount = 300;
const catalogAverageRating = 6.5;
const ratingSpread = 1.5;
const fewestVotes = 30;
const lowestWeightedRating = 5.6;
/** Someone who never watches anime should not get it from a stray genre match. */
const animeStrangerShare = 0.05;
const animeStrangerPenalty = 0.25;
/** Each extra pick from the same source title, or of the same leading genre, costs this much. */
const repeatedSourcePenalty = 0.07;
const repeatedGenrePenalty = 0.03;

/** The catalog rating pulled towards the average while few people have voted. */
export function weightedRating(item: MediaItem): number {
  const votes = item.voteCount;
  return (votes * item.rating + trustedVoteCount * catalogAverageRating) / (votes + trustedVoteCount);
}

/** Titles rated at least `lowestRating` (after weighting by votes), best first. */
export function bestRated(items: MediaItem[], lowestRating: number = lowestWeightedRating): MediaItem[] {
  return items
    .filter((item) => item.voteCount >= fewestVotes && weightedRating(item) >= lowestRating)
    .sort((a, b) => weightedRating(b) - weightedRating(a));
}

/**
 * Scores every candidate against the profile and returns the best `limit`, spread out so one
 * favourite title or genre does not fill the whole row.
 *
 * `seeds` bring in titles similar to what the user liked (and push away what resembles a dislike);
 * `extra` are further candidates found by genre or by people.
 */
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

  // Greedy pick: the best remaining title, counting what is already in the row against look-alikes.
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
