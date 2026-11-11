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

const likedSeedLimit = 10;
const dislikedSeedLimit = 3;
const dismissedSeedLimit = 2;
const forYouLimit = 20;
const rowLimit = 18;
const becauseRowLimit = 2;
const genreRowLimit = 2;
const fewestTitlesForPersonRow = 2;
const shortestRow = 5;
const rowWorthyRating = 6.3;
const likedRating = 7;

const seriesGenreIds: Record<number, number> = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 };
const filmOnlyGenres = new Set([27, 53, 10749, 36, 10402]);

export interface FeedRow {
  id: string;
  title: string;
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
  const genreType: MediaType = profile.types.tv > profile.types.movie ? "tv" : "movie";
  const genreRequests = genres
    .filter((genre) => genreType === "movie" || !filmOnlyGenres.has(genre))
    .map((genre) => ({ genre, id: genreType === "tv" ? (seriesGenreIds[genre] ?? genre) : genre }));

  const [genreNames, genreLists, personList] = await Promise.all([
    tmdb.genreNames().catch(() => new Map<number, string>()),
    Promise.allSettled(genreRequests.map((request) => tmdb.bestOfGenre(genreType, request.id))),
    person ? tmdb.personFilms(person.id, person.role).catch(() => []) : Promise.resolve([]),
  ]);

  const known = new Set([...Object.keys(tracked), ...Object.keys(dismissed)]);
  const shown = new Set<string>();
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
  available: boolean;
  rows: FeedRow[] | null;
}

export function usePersonalFeed(): PersonalFeed {
  const tracked = useLibrary((state) => state.tracked);
  const loaded = useLibrary((state) => state.loaded);
  const dismissed = useLibrary((state) => state.dismissed);
  const signals = useMemo(() => tasteSignals(tracked, Date.now()), [tracked]);
  const signature = useMemo(
    () => signals.map((signal) => `${titleKey(signal.title.type, signal.title.id)}=${signal.weight.toFixed(1)}`).join("|"),
    [signals],
  );
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
