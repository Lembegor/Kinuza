// AniList: what the general catalog does not know about anime — the romaji name releases are
// published under, and the parts of a franchise (seasons, films, OVAs) in the order they came out.
// The catalog keeps a whole anime as one series; fans and trackers name every part separately.
// Open API, no key; only the title being looked up is sent.

const endpoint = "https://graphql.anilist.co";
/** Rounds of following prequels and sequels; each is one request and reaches one part further. */
const maxRounds = 8;
/** A franchise longer than this is shown up to here. */
const maxParts = 30;
const searchCandidates = 8;

export type AnimeFormat = "TV" | "TV_SHORT" | "MOVIE" | "OVA" | "ONA" | "SPECIAL";
const shownFormats: ReadonlySet<string> = new Set<AnimeFormat>(["TV", "TV_SHORT", "MOVIE", "OVA", "ONA", "SPECIAL"]);
/** Relations that continue the story; a part reached through them is looked at for more. */
const storyRelations: ReadonlySet<string> = new Set(["PREQUEL", "SEQUEL", "PARENT"]);
/** Relations worth showing but not following: their own side stories would lead away from the franchise. */
const sideRelations: ReadonlySet<string> = new Set(["SIDE_STORY", "SUMMARY"]);

export interface AnimePart {
  id: number;
  /** The name in Latin script, as releases are titled. */
  romaji: string;
  english: string;
  format: AnimeFormat;
  /** "2013-04-07"; shorter or empty when the date is not fully known. */
  startDate: string;
  year: number | null;
  cover: string | null;
  /** How many episodes; null while it is airing or unknown. */
  episodes: number | null;
}

export interface AnimeInfo {
  current: AnimePart;
  /** Every part found, the current one included, earliest first. */
  parts: AnimePart[];
}

interface RawMedia {
  id: number;
  type?: string;
  format?: string | null;
  episodes?: number | null;
  title?: { romaji?: string | null; english?: string | null };
  startDate?: { year?: number | null; month?: number | null; day?: number | null };
  coverImage?: { large?: string | null };
  relations?: { edges?: { relationType?: string; node?: RawMedia }[] };
}

const fields = `id type format episodes title { romaji english } startDate { year month day } coverImage { large }`;
const withRelations = `${fields} relations { edges { relationType node { ${fields} } } }`;

async function ask<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`anilist_${response.status}`);
  return ((await response.json()) as { data: T }).data;
}

function toPart(raw: RawMedia): AnimePart | null {
  if (raw.type !== "ANIME" || !raw.format || !shownFormats.has(raw.format)) return null;
  const { year, month, day } = raw.startDate ?? {};
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    id: raw.id,
    romaji: raw.title?.romaji ?? "",
    english: raw.title?.english ?? "",
    format: raw.format as AnimeFormat,
    startDate: year ? [String(year), ...(month ? [pad(month), ...(day ? [pad(day)] : [])] : [])].join("-") : "",
    year: year ?? null,
    cover: raw.coverImage?.large ?? null,
    episodes: raw.episodes ?? null,
  };
}

export interface AnimeQuery {
  /** Names to try, the most exact first: the original one, then the English one. */
  names: string[];
  type: "movie" | "tv";
  year: number | null;
}

/** The entry that is this title: the right kind, and from the same year give or take one. */
async function findEntry({ names, type, year }: AnimeQuery): Promise<RawMedia | null> {
  for (const name of names.filter(Boolean)) {
    const data = await ask<{ Page: { media: RawMedia[] } }>(
      `query ($search: String, $count: Int) { Page(perPage: $count) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { ${withRelations} } } }`,
      { search: name, count: searchCandidates },
    );
    const match = data.Page.media.find((media) => {
      const sameKind = type === "movie" ? media.format === "MOVIE" : media.format !== "MOVIE" && shownFormats.has(media.format ?? "");
      const mediaYear = media.startDate?.year;
      return sameKind && (year === null || !mediaYear || Math.abs(mediaYear - year) <= 1);
    });
    if (match) return match;
  }
  return null;
}

const cache = new Map<string, Promise<AnimeInfo | null>>();

/** What AniList knows about a title; null when it has no such anime. Answers are kept for the session. */
export function animeInfo(query: AnimeQuery): Promise<AnimeInfo | null> {
  const key = JSON.stringify(query);
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = loadAnime(query);
  pending.catch(() => cache.delete(key));
  cache.set(key, pending);
  return pending;
}

async function loadAnime(query: AnimeQuery): Promise<AnimeInfo | null> {
  const root = await findEntry(query);
  const current = root && toPart(root);
  if (!root || !current) return null;

  const parts = new Map<number, AnimePart>([[current.id, current]]);
  let frontier: RawMedia[] = [root];
  for (let round = 0; round < maxRounds && frontier.length > 0 && parts.size < maxParts; round++) {
    const next: number[] = [];
    for (const media of frontier) {
      for (const { relationType = "", node } of media.relations?.edges ?? []) {
        const part = node && toPart(node);
        if (!part || parts.has(part.id) || !(storyRelations.has(relationType) || sideRelations.has(relationType))) continue;
        parts.set(part.id, part);
        if (storyRelations.has(relationType)) next.push(part.id);
      }
    }
    if (next.length === 0) break;
    const data = await ask<{ Page: { media: RawMedia[] } }>(
      `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${withRelations} } } }`,
      { ids: next },
    );
    frontier = data.Page.media;
  }

  // Undated parts are announcements; they go last.
  const ordered = [...parts.values()].sort((a, b) => (a.startDate || "9999").localeCompare(b.startDate || "9999")).slice(0, maxParts);
  return { current, parts: ordered };
}
