// The personal part of the home page: rows of titles picked for this user from what they rated and watched.

import { useMemo } from "react";
import type { Dismissal } from "../lib/account";
import { t } from "../lib/i18n";
import { tmdb, type MediaItem, type MediaType, type TitleTaste } from "../lib/tmdb";
import {
  bestRated,
  buildProfile,
  dismissalSignals,
  favoriteGenres,
  rankCandidates,
  tasteSignals,
  type PersonAffinity,
  type TasteSignal,
} from "../lib/taste";
import { useAsync } from "../lib/useAsync";
import { titleKey, useLibrary, type TrackEntry } from "./library";

/** Liked titles looked up in the catalog; more adds requests without changing the picture much. */
const likedSeedLimit = 10;
/** Disliked titles looked up, to steer away from what resembles them. */
const dislikedSeedLimit = 3;
/** Dismissed recommendations looked up as well: the latest few say enough, and each costs a request. */
const dismissedSeedLimit = 2;
const forYouLimit = 20;
const rowLimit = 18;
/** Rows of the "because you liked X" kind. */
const becauseRowLimit = 2;
const genreRowLimit = 2;
/** A person earns a row once this many liked titles share them. */
const fewestTitlesForPersonRow = 2;
/** Rows shorter than this look like a mistake rather than a recommendation. */
const shortestRow = 5;
/** Weighted catalog rating a title needs to appear in a "because you liked X" row. */
const rowWorthyRating = 6.3;
/** A personal rating from here up, or a finished title, reads as "liked"; below it the user is still watching. */
const likedRating = 7;

/** Genre ids that exist for series only under a combined id. */
const seriesGenreIds: Record<number, number> = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 };
/** Film genres the series catalog does not have at all. */
const filmOnlyGenres = new Set([27, 53, 10749, 36, 10402]);

export interface FeedRow {
  id: string;
  title: string;
  /** `note` under a card says why the title is there. */
  items: (MediaItem & { note?: string })[];
}

interface Seed {
  signal: TasteSignal;
  source: TitleTaste;
}

function settled<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

function becauseTitle(signal: TasteSignal, entry: TrackEntry | undefined): string {
  const liked = (entry?.rating ?? 0) >= likedRating || signal.status === "completed";
  const title = signal.title.title;
  if (liked) return t("feed.because.liked", { title });
  return signal.status === "planned" ? t("feed.because.planned", { title }) : t("feed.because.watching", { title });
}

function personTitle(person: PersonAffinity): string {
  return person.role === "director" ? t("feed.person.director", { name: person.name }) : t("feed.person.cast", { name: person.name });
}

/** Looks up the strongest signals in the catalog and assembles the rows. */
async function buildFeed(
  tracked: Record<string, TrackEntry>,
  dismissed: Record<string, Dismissal>,
  signals: TasteSignal[],
): Promise<FeedRow[]> {
  const chosen = [
    ...signals.filter((signal) => signal.weight > 0).slice(0, likedSeedLimit),
    ...signals.filter((signal) => signal.weight < 0).slice(0, dislikedSeedLimit),
    ...dismissalSignals(dismissed, tracked, Date.now()).slice(0, dismissedSeedLimit),
  ];
  const sources = await Promise.allSettled(chosen.map((signal) => tmdb.taste(signal.title.type, signal.title.id)));
  const seeds: Seed[] = chosen.flatMap((signal, index) => {
    const result = sources[index];
    return result.status === "fulfilled" ? [{ signal, source: result.value }] : [];
  });
  const liked = seeds.filter((seed) => seed.signal.weight > 0);
  if (liked.length === 0) return [];

  const profile = buildProfile(seeds);
  const genres = favoriteGenres(profile, genreRowLimit);
  const person = profile.people.find((candidate) => candidate.titles >= fewestTitlesForPersonRow) ?? null;
  // Series get a genre row only if the user watches series more than films.
  const genreType: MediaType = profile.types.tv > profile.types.movie ? "tv" : "movie";
  const genreRequests = genres
    .filter((genre) => genreType === "movie" || !filmOnlyGenres.has(genre))
    .map((genre) => ({ genre, id: genreType === "tv" ? (seriesGenreIds[genre] ?? genre) : genre }));

  const [genreNames, genreLists, personList] = await Promise.all([
    tmdb.genreNames().catch(() => new Map<number, string>()),
    Promise.allSettled(genreRequests.map((request) => tmdb.bestOfGenre(genreType, request.id))),
    person ? tmdb.personFilms(person.id, person.role).catch(() => []) : Promise.resolve([]),
  ]);

  // Anything the user already tracks, in any status, is not a recommendation; nor is what they turned down.
  const known = new Set([...Object.keys(tracked), ...Object.keys(dismissed)]);
  const shown = new Set<string>();
  // Not tracked, not in an earlier row, and once only (a title can be both "recommended" and "similar").
  const fresh = <T extends MediaItem>(items: T[], limit: number): T[] => {
    const seen = new Set<string>();
    return items
      .filter((item) => {
        const key = titleKey(item.type, item.id);
        if (known.has(key) || shown.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  };
  const rows: FeedRow[] = [];
  const push = (row: FeedRow) => {
    if (row.items.length < shortestRow) return;
    for (const item of row.items) shown.add(titleKey(item.type, item.id));
    rows.push(row);
  };

  const extra = [...settled(genreLists).flat(), ...personList];
  const forYou = rankCandidates(seeds, extra, profile, known, forYouLimit);
  push({
    id: "for-you",
    title: t("feed.forYou"),
    items: fresh(
      forYou.map(({ item, because }) => ({ ...item, note: because ? t("feed.similarTo", { title: because.title }) : undefined })),
      forYouLimit,
    ),
  });

  for (const seed of liked.slice(0, becauseRowLimit)) {
    push({
      id: `because:${titleKey(seed.signal.title.type, seed.signal.title.id)}`,
      title: becauseTitle(seed.signal, tracked[titleKey(seed.signal.title.type, seed.signal.title.id)]),
      // The catalog's list runs long and thins out; only what is well rated belongs in a row of its own.
      // Its looser "similar" list is left to the blended row above, where taste weighs it.
      items: fresh(bestRated(seed.source.recommendations, rowWorthyRating), rowLimit),
    });
  }

  if (person) push({ id: `person:${person.id}`, title: personTitle(person), items: fresh(bestRated(personList), rowLimit) });

  genreRequests.forEach((request, index) => {
    const result = genreLists[index];
    const name = genreNames.get(request.id) ?? genreNames.get(request.genre);
    if (result.status !== "fulfilled" || !name) return;
    push({
      id: `genre:${genreType}:${request.id}`,
      title: t("feed.genre", { genre: name.toLowerCase() }),
      items: fresh(result.value, rowLimit),
    });
  });

  return rows;
}

export interface PersonalFeed {
  /** The user has rated or watched enough for recommendations to exist. */
  available: boolean;
  /** Null while the rows are being put together. */
  rows: FeedRow[] | null;
}

/**
 * Rows for the home page. They are rebuilt when the user's taste changes (a new rating, a
 * finished film), not on every saved playback position.
 */
export function usePersonalFeed(): PersonalFeed {
  const tracked = useLibrary((state) => state.tracked);
  const loaded = useLibrary((state) => state.loaded);
  const dismissed = useLibrary((state) => state.dismissed);
  // The age fade moves weights slowly; the day they are read on is precise enough and keeps this stable.
  const signals = useMemo(() => tasteSignals(tracked, Date.now()), [tracked]);
  const signature = useMemo(
    () => signals.map((signal) => `${titleKey(signal.title.type, signal.title.id)}=${signal.weight.toFixed(1)}`).join("|"),
    [signals],
  );
  // A dismissal is not part of the signature on purpose: rebuilding would reshuffle every row under
  // the user's cursor. The card is taken out below, and the next rebuild counts the dismissal in.
  const feed = useAsync(() => (loaded ? buildFeed(tracked, dismissed, signals) : Promise.resolve([])), [signature, loaded]);
  const rows = useMemo(
    () =>
      (feed.data ?? [])
        .map((row) => ({ ...row, items: row.items.filter((item) => !(titleKey(item.type, item.id) in dismissed)) }))
        .filter((row) => row.items.length > 0),
    [feed.data, dismissed],
  );

  const available = signals.some((signal) => signal.weight > 0);
  return { available, rows: feed.loading ? null : rows };
}
