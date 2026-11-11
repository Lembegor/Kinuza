import type { Dismissal } from "./account";
import type { MediaItem, MediaType, TitleKeyword, TitleTaste } from "./tmdb";
import type { Progress, TitleRef, TrackEntry, WatchStatus } from "../state/library";

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
const likedWeight = 0.6;
const untriedDropWeight = -0.15;
const oldestSignalShare = 0.4;
const tasteHalfLifeDays = 240;
const weakestSignal = 0.08;

const sampleSeconds = 8 * 60;
const sampleShare = 0.1;
const finishedPlayShare = 0.5;
const watchedShare = 0.92;
const movieIdleDays = 14;
const seriesIdleDays = 21;
const implicitWeights = {
  finishedMovie: 0.6,
  mostlyWatched: 0.3,
  inProgress: 0.2,
  abandonedEarly: -0.35,
  abandonedMidway: -0.15,
  seriesBase: 0.25,
  seriesPerEpisode: 0.1,
  seriesMost: 0.75,
  seriesStarted: 0.15,
  seriesAbandoned: -0.3,
};
const earlyShare = 0.35;
const midwayShare = 0.75;
const bingedEpisodes = 5;

export type DismissReason = "seen" | "genre" | "person" | "other";

export const dismissWeights: Record<DismissReason, number> = {
  seen: 0,
  genre: -0.3,
  person: -0.2,
  other: -0.2,
};

export type SignalOrigin = "rating" | "liked" | "status" | "finished" | "binged" | "watching" | "abandoned" | "dismissed";

export interface TasteSignal {
  title: TitleRef;
  weight: number;
  rated: boolean;
  status: WatchStatus | null;
  origin: SignalOrigin;
  at: number;
  reason?: DismissReason;
  personId?: number;
}

export interface PersonAffinity {
  id: number;
  name: string;
  role: "director" | "cast";
  affinity: number;
  titles: number;
}

export interface KeywordAffinity {
  id: number;
  name: string;
  affinity: number;
  titles: number;
}

export interface TasteProfile {
  genres: Map<number, number>;
  avoidedGenres: Map<number, number>;
  keywords: Map<number, KeywordAffinity>;
  avoidedKeywords: Set<number>;
  people: PersonAffinity[];
  avoidedPeople: Set<number>;
  types: Record<MediaType, number>;
  anime: number;
  languages: Map<string, number>;
}

export type ReasonKind = "similar" | "collection" | "person" | "theme" | "fresh" | "genre";

export interface Reason {
  kind: ReasonKind;
  title?: TitleRef;
  name?: string;
  role?: "director" | "cast";
}

export interface Recommendation {
  item: MediaItem;
  score: number;
  reason: Reason | null;
}

export interface Seed {
  signal: TasteSignal;
  source: TitleTaste;
}

export interface CandidateSource {
  item: MediaItem;
  kind: Exclude<ReasonKind, "similar">;
  strength: number;
  reason: Reason;
}

const combinedGenres: Record<number, number[]> = {
  10759: [28, 12],
  10765: [878, 14],
  10768: [10752],
};

const genericKeyword =
  /stinger|woman director|based on (a |an )?(novel|book|comic|manga|video game|short story|play|true story|tv series)|sequel|remake|reboot|duringcredits|aftercredits|independent film|live action|anime|3d|imax|female protagonist|male protagonist|ensemble cast|^death$|^murder$|^love$|^friendship$|^family$|relationship|new york city|london, england|los angeles, california|aftermath|lgbt/i;

export function canonicalGenres(genreIds: number[]): number[] {
  return [...new Set(genreIds.flatMap((id) => combinedGenres[id] ?? [id]))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function key(title: Pick<TitleRef, "type" | "id">): string {
  return `${title.type}:${title.id}`;
}

function faded(weight: number, at: number, now: number): number {
  const ageDays = Math.max(0, now - at) / msPerDay;
  return weight * (oldestSignalShare + (1 - oldestSignalShare) * 0.5 ** (ageDays / tasteHalfLifeDays));
}

export interface WatchEvidence {
  type: MediaType;
  played: number;
  duration: number;
  share: number;
  finished: number;
  engaged: boolean;
  marked: boolean;
  lastAt: number;
}

function isMarkedByHand(item: Progress): boolean {
  return item.duration === 1 && item.position === 1;
}

export function watchEvidence(progress: Record<string, Progress>): Map<string, WatchEvidence> {
  const evidence = new Map<string, WatchEvidence>();
  for (const item of Object.values(progress)) {
    const titleKeyOf = key(item.title);
    const known = evidence.get(titleKeyOf) ?? {
      type: item.title.type,
      played: 0,
      duration: 0,
      share: 0,
      finished: 0,
      engaged: false,
      marked: false,
      lastAt: 0,
    };
    known.lastAt = Math.max(known.lastAt, item.updatedAt);
    if (isMarkedByHand(item)) {
      known.marked = true;
      known.finished += 1;
      evidence.set(titleKeyOf, known);
      continue;
    }
    const duration = item.duration > 0 ? item.duration : 0;
    const played = Math.min(duration || Infinity, item.played ?? item.position);
    const reachedEnd = duration > 0 && item.position / duration >= watchedShare;
    const reallyPlayed = duration > 0 && played >= duration * finishedPlayShare;
    if (reachedEnd && reallyPlayed) known.finished += 1;
    if (played >= Math.max(sampleSeconds, duration * sampleShare)) known.engaged = true;
    known.played += played;
    known.duration += duration;
    known.share = known.duration > 0 ? known.played / known.duration : 0;
    evidence.set(titleKeyOf, known);
  }
  return evidence;
}

function implicitSignal(evidence: WatchEvidence, now: number): { weight: number; origin: SignalOrigin } | null {
  if (evidence.marked && evidence.type === "movie") return null;
  const idleDays = (now - evidence.lastAt) / msPerDay;
  if (evidence.type === "tv") {
    if (evidence.finished > 0) {
      const weight = Math.min(implicitWeights.seriesMost, implicitWeights.seriesBase + implicitWeights.seriesPerEpisode * evidence.finished);
      return { weight, origin: evidence.finished >= bingedEpisodes ? "binged" : "finished" };
    }
    if (!evidence.engaged) return { weight: 0, origin: "watching" };
    if (idleDays < seriesIdleDays) return { weight: implicitWeights.seriesStarted, origin: "watching" };
    return { weight: implicitWeights.seriesAbandoned, origin: "abandoned" };
  }
  if (evidence.finished > 0) return { weight: implicitWeights.finishedMovie, origin: "finished" };
  if (!evidence.engaged) return { weight: 0, origin: "watching" };
  if (idleDays < movieIdleDays) return { weight: implicitWeights.inProgress, origin: "watching" };
  if (evidence.share < earlyShare) return { weight: implicitWeights.abandonedEarly, origin: "abandoned" };
  if (evidence.share < midwayShare) return { weight: implicitWeights.abandonedMidway, origin: "abandoned" };
  return { weight: implicitWeights.mostlyWatched, origin: "finished" };
}

const explicitStatuses: ReadonlySet<WatchStatus> = new Set<WatchStatus>(["planned", "onHold", "dropped"]);

export function tasteSignals(tracked: Record<string, TrackEntry>, progress: Record<string, Progress>, now: number): TasteSignal[] {
  const evidence = watchEvidence(progress);
  const signals: TasteSignal[] = [];
  for (const entry of Object.values(tracked)) {
    const seen = evidence.get(key(entry));
    const implicit = seen ? implicitSignal(seen, now) : null;
    let stated: number;
    let origin: SignalOrigin;
    if (entry.rating !== null) {
      stated = clamp((entry.rating - neutralRating) / ratingSpan, -1, 1);
      origin = "rating";
    } else if (entry.liked) {
      stated = likedWeight;
      origin = "liked";
    } else if (entry.status === "dropped" && seen && !seen.engaged && seen.finished === 0) {
      stated = untriedDropWeight;
      origin = "status";
    } else if (entry.status && explicitStatuses.has(entry.status)) {
      stated = statusWeights[entry.status];
      origin = "status";
    } else if (implicit) {
      stated = implicit.weight;
      origin = implicit.origin;
    } else {
      stated = entry.status ? statusWeights[entry.status] : 0;
      origin = "status";
    }
    const at = Math.max(entry.updatedAt, seen?.lastAt ?? 0);
    const weight = faded(stated, at, now);
    if (Math.abs(weight) < weakestSignal) continue;
    const { type, id, title, poster, backdrop, year } = entry;
    signals.push({
      title: { type, id, title, poster, backdrop, year },
      weight,
      rated: entry.rating !== null || entry.liked === true,
      status: entry.status,
      origin,
      at,
    });
  }
  return signals.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

export function dismissalSignals(dismissed: Record<string, Dismissal>, tracked: Record<string, TrackEntry>, now: number): TasteSignal[] {
  return Object.values(dismissed)
    .filter((dismissal) => !(key(dismissal) in tracked))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((dismissal) => {
      const { type, id, title, poster, backdrop, year } = dismissal;
      const why: DismissReason = dismissal.reason ?? "other";
      const signal: TasteSignal = {
        title: { type, id, title, poster, backdrop, year },
        weight: faded(dismissWeights[why], dismissal.updatedAt, now),
        rated: false,
        status: null,
        origin: "dismissed",
        at: dismissal.updatedAt,
        reason: why,
        personId: dismissal.personId,
      };
      return signal;
    })
    .filter((signal) => Math.abs(signal.weight) >= weakestSignal);
}

export function isGenericKeyword(keyword: TitleKeyword): boolean {
  return genericKeyword.test(keyword.name);
}

const explicitGenreEvidence = 2;
const negativeEvidenceNeeded = 2;
const avoidanceMargin = 1.2;

export function buildProfile(seeds: Seed[]): TasteProfile {
  const genrePositive = new Map<number, number>();
  const genreNegative = new Map<number, { sum: number; titles: number }>();
  const keywordPositive = new Map<number, KeywordAffinity>();
  const keywordNegative = new Map<number, number>();
  const people = new Map<number, PersonAffinity>();
  const peopleNegative = new Map<number, number>();
  const avoidedPeople = new Set<number>();
  const languages = new Map<string, number>();
  const types: Record<MediaType, number> = { movie: 0, tv: 0 };
  let anime = 0;
  let totalWeight = 0;
  let positiveWeight = 0;

  for (const { signal, source } of seeds) {
    const { weight } = signal;
    totalWeight += Math.abs(weight);
    const genres = canonicalGenres(source.item.genreIds);
    const keywords = source.keywords.filter((keyword) => !isGenericKeyword(keyword));
    const keywordShare = keywords.length > 0 ? 1 / Math.sqrt(keywords.length) : 0;

    if (weight > 0) {
      positiveWeight += weight;
      types[source.item.type] += weight;
      if (source.item.isAnime) anime += weight;
      languages.set(source.item.language, (languages.get(source.item.language) ?? 0) + weight);
      for (const genre of genres) genrePositive.set(genre, (genrePositive.get(genre) ?? 0) + weight);
      for (const keyword of keywords) {
        const known = keywordPositive.get(keyword.id) ?? { id: keyword.id, name: keyword.name, affinity: 0, titles: 0 };
        known.affinity += weight * keywordShare;
        known.titles += 1;
        keywordPositive.set(keyword.id, known);
      }
      for (const person of source.people) {
        const known = people.get(person.id) ?? { ...person, affinity: 0, titles: 0 };
        known.affinity += person.role === "director" ? weight : weight / 2;
        known.titles += 1;
        people.set(person.id, known);
      }
      continue;
    }

    if (signal.reason === "person" && signal.personId !== undefined) {
      avoidedPeople.add(signal.personId);
      continue;
    }
    const explicitGenre = signal.reason === "genre";
    for (const genre of genres) {
      const known = genreNegative.get(genre) ?? { sum: 0, titles: 0 };
      known.sum += -weight * (explicitGenre ? 2 : 1);
      known.titles += explicitGenre ? explicitGenreEvidence : 1;
      genreNegative.set(genre, known);
    }
    for (const keyword of keywords) keywordNegative.set(keyword.id, (keywordNegative.get(keyword.id) ?? 0) + 1);
    if (signal.origin !== "dismissed") {
      for (const person of source.people) peopleNegative.set(person.id, (peopleNegative.get(person.id) ?? 0) + 1);
    }
  }

  const avoidedGenres = new Map<number, number>();
  for (const [genre, negative] of genreNegative) {
    const positive = genrePositive.get(genre) ?? 0;
    if (negative.titles < negativeEvidenceNeeded || negative.sum <= positive * avoidanceMargin) continue;
    avoidedGenres.set(genre, clamp((negative.sum - positive) / (negative.sum + positive + 0.5), 0, 1));
  }
  const avoidedKeywords = new Set<number>(
    [...keywordNegative].filter(([id, count]) => count >= negativeEvidenceNeeded && !keywordPositive.has(id)).map(([id]) => id),
  );
  for (const [id, count] of peopleNegative) if (count >= negativeEvidenceNeeded && !people.has(id)) avoidedPeople.add(id);

  const genres = new Map<number, number>();
  for (const genre of new Set([...genrePositive.keys(), ...genreNegative.keys()])) {
    const net = (genrePositive.get(genre) ?? 0) - (genreNegative.get(genre)?.sum ?? 0);
    genres.set(genre, totalWeight > 0 ? net / totalWeight : 0);
  }

  const share = (value: number) => (positiveWeight > 0 ? value / positiveWeight : 0);
  return {
    genres,
    avoidedGenres,
    keywords: keywordPositive,
    avoidedKeywords,
    people: [...people.values()].filter((person) => !avoidedPeople.has(person.id)).sort((a, b) => b.affinity - a.affinity),
    avoidedPeople,
    types: { movie: share(types.movie), tv: share(types.tv) },
    anime: share(anime),
    languages: new Map([...languages].map(([language, sum]) => [language, share(sum)])),
  };
}

export function favoriteGenres(profile: TasteProfile, limit: number): number[] {
  return [...profile.genres]
    .filter(([genre, affinity]) => affinity > 0 && !profile.avoidedGenres.has(genre))
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([genre]) => genre);
}

export function favoriteKeywords(profile: TasteProfile, limit: number): KeywordAffinity[] {
  return [...profile.keywords.values()]
    .filter((keyword) => keyword.titles >= 2)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, limit);
}

export interface RankWeights {
  similarity: number;
  content: number;
  genres: number;
  quality: number;
  kind: number;
  language: number;
  agreement: number;
  avoidance: number;
}

export const weightPresets: Record<string, RankWeights> = {
  balanced: { similarity: 0.36, content: 0.18, genres: 0.14, quality: 0.12, kind: 0.06, language: 0.05, agreement: 0.09, avoidance: 0.35 },
  similar: { similarity: 0.5, content: 0.12, genres: 0.1, quality: 0.1, kind: 0.06, language: 0.04, agreement: 0.08, avoidance: 0.35 },
  themes: { similarity: 0.26, content: 0.26, genres: 0.18, quality: 0.11, kind: 0.06, language: 0.05, agreement: 0.08, avoidance: 0.35 },
  acclaimed: { similarity: 0.32, content: 0.15, genres: 0.12, quality: 0.22, kind: 0.06, language: 0.05, agreement: 0.08, avoidance: 0.35 },
};

export const defaultPreset = "balanced";

const similarityHalfRank = 6;
const looseSimilarityShare = 0.5;
const trustedVoteCount = 300;
const catalogAverageRating = 6.5;
const ratingSpread = 1.5;
const fewestVotes = 30;
const lowestWeightedRating = 5.6;
const animeStrangerShare = 0.05;
const animeStrangerPenalty = 0.25;
const repeatedReasonPenalty = 0.07;
const repeatedGenrePenalty = 0.03;
const repeatedKindPenalty = 0.02;
const contentReasonShare = 0.6;

export function weightedRating(item: MediaItem): number {
  const votes = item.voteCount;
  return (votes * item.rating + trustedVoteCount * catalogAverageRating) / (votes + trustedVoteCount);
}

export function bestRated(items: MediaItem[], lowestRating: number = lowestWeightedRating): MediaItem[] {
  return items
    .filter((item) => item.voteCount >= fewestVotes && weightedRating(item) >= lowestRating)
    .sort((a, b) => weightedRating(b) - weightedRating(a));
}

function reasonKey(reason: Reason | null): string {
  if (!reason) return "";
  return `${reason.kind}:${reason.title ? key(reason.title) : (reason.name ?? "")}`;
}

export function rankCandidates(
  seeds: Seed[],
  extra: CandidateSource[],
  profile: TasteProfile,
  excluded: ReadonlySet<string>,
  limit: number,
  weights: RankWeights = weightPresets[defaultPreset],
): Recommendation[] {
  interface Candidate {
    item: MediaItem;
    similarity: number;
    content: number;
    kinds: Set<string>;
    reason: Reason | null;
    strongest: number;
  }
  const candidates = new Map<string, Candidate>();
  const candidate = (item: MediaItem): Candidate => {
    const known = candidates.get(key(item));
    if (known) return known;
    const fresh: Candidate = { item, similarity: 0, content: 0, kinds: new Set(), reason: null, strongest: 0 };
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
        if (link > 0) entry.kinds.add("similar");
        if (link > entry.strongest) {
          entry.strongest = link;
          entry.reason = { kind: "similar", title: signal.title };
        }
      });
    }
  }
  for (const source of extra) {
    const entry = candidate(source.item);
    entry.content += source.strength;
    entry.kinds.add(source.kind);
    const link = source.strength * contentReasonShare;
    if (link > entry.strongest) {
      entry.strongest = link;
      entry.reason = source.reason;
    }
  }

  const strongestSimilarity = Math.max(0, ...[...candidates.values()].map((entry) => entry.similarity));
  const strongestContent = Math.max(0, ...[...candidates.values()].map((entry) => entry.content));
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
    const avoided = genres.length > 0 ? genres.reduce((sum, genre) => sum + (profile.avoidedGenres.get(genre) ?? 0), 0) / genres.length : 0;
    const languageMatch = favouriteLanguageShare > 0 ? (profile.languages.get(item.language) ?? 0) / favouriteLanguageShare : 0;

    let score =
      weights.similarity * (strongestSimilarity > 0 ? clamp(entry.similarity / strongestSimilarity, -1, 1) : 0) +
      weights.content * (strongestContent > 0 ? clamp(entry.content / strongestContent, 0, 1) : 0) +
      weights.genres * clamp(genreMatch, -1, 1) +
      weights.quality * clamp((rating - catalogAverageRating) / ratingSpread, -1, 1) +
      weights.kind * profile.types[item.type] +
      weights.language * languageMatch +
      weights.agreement * Math.min(1, Math.max(0, entry.kinds.size - 1) / 2) -
      weights.avoidance * avoided;
    if (item.isAnime && profile.anime < animeStrangerShare) score -= animeStrangerPenalty;

    scored.push({ item, score, reason: entry.reason });
  }

  const picked: Recommendation[] = [];
  const perReason = new Map<string, number>();
  const perGenre = new Map<number, number>();
  const perKind = new Map<string, number>();
  const remaining = scored.sort((a, b) => b.score - a.score);
  while (picked.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    remaining.forEach((entry, index) => {
      const sameReason = perReason.get(reasonKey(entry.reason)) ?? 0;
      const sameGenre = perGenre.get(canonicalGenres(entry.item.genreIds)[0] ?? -1) ?? 0;
      const sameKind = perKind.get(entry.reason?.kind ?? "") ?? 0;
      const adjusted = entry.score - sameReason * repeatedReasonPenalty - sameGenre * repeatedGenrePenalty - sameKind * repeatedKindPenalty;
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestIndex = index;
      }
    });
    const [choice] = remaining.splice(bestIndex, 1);
    picked.push(choice);
    const reason = reasonKey(choice.reason);
    if (reason) perReason.set(reason, (perReason.get(reason) ?? 0) + 1);
    const leadingGenre = canonicalGenres(choice.item.genreIds)[0];
    if (leadingGenre !== undefined) perGenre.set(leadingGenre, (perGenre.get(leadingGenre) ?? 0) + 1);
    const kind = choice.reason?.kind ?? "";
    perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
  }
  return picked;
}
