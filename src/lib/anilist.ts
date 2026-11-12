const endpoint = "https://graphql.anilist.co";
const maxRounds = 8;
const maxParts = 30;
const searchCandidates = 8;

export type AnimeFormat = "TV" | "TV_SHORT" | "MOVIE" | "OVA" | "ONA" | "SPECIAL";
const shownFormats: ReadonlySet<string> = new Set<AnimeFormat>(["TV", "TV_SHORT", "MOVIE", "OVA", "ONA", "SPECIAL"]);
const storyRelations: ReadonlySet<string> = new Set(["PREQUEL", "SEQUEL", "PARENT"]);
const sideRelations: ReadonlySet<string> = new Set(["SIDE_STORY", "SUMMARY"]);

export interface AnimePart {
  id: number;
  malId: number | null;
  romaji: string;
  english: string;
  format: AnimeFormat;
  startDate: string;
  year: number | null;
  cover: string | null;
  episodes: number | null;
}

export interface AnimeInfo {
  current: AnimePart;
  parts: AnimePart[];
}

interface RawMedia {
  id: number;
  idMal?: number | null;
  type?: string;
  format?: string | null;
  episodes?: number | null;
  title?: { romaji?: string | null; english?: string | null };
  startDate?: { year?: number | null; month?: number | null; day?: number | null };
  coverImage?: { large?: string | null };
  relations?: { edges?: { relationType?: string; node?: RawMedia }[] };
}

const fields = `id idMal type format episodes title { romaji english } startDate { year month day } coverImage { large }`;
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
    malId: raw.idMal ?? null,
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
  names: string[];
  type: "movie" | "tv";
  year: number | null;
}

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

export interface AnimeText {
  id: number;
  malId: number | null;
  english: string;
  native: string;
  romaji: string;
  description: string;
}

interface RawText {
  id: number;
  idMal?: number | null;
  title?: { english?: string | null; native?: string | null; romaji?: string | null };
  description?: string | null;
}

const htmlEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…" };

export function cleanAnimeDescription(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code.startsWith("#")) {
        const point = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
      }
      return htmlEntities[code.toLowerCase()] ?? entity;
    })
    .replace(/~!([\s\S]*?)!~/g, "")
    .replace(/\(\s*(source|written by)[^()]*\)\s*$/i, "")
    .replace(/\[\s*written by[^\]]*\]\s*$/i, "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

const textCache = new Map<string, Promise<AnimeText | null>>();

export function animeText(by: { id: number } | { malId: number }): Promise<AnimeText | null> {
  const key = "id" in by ? `id:${by.id}` : `mal:${by.malId}`;
  const cached = textCache.get(key);
  if (cached) return cached;
  const argument = "id" in by ? "id" : "idMal";
  const value = "id" in by ? by.id : by.malId;
  const pending = ask<{ Media: RawText | null }>(
    `query ($value: Int) { Media(${argument}: $value, type: ANIME) { id idMal title { english native romaji } description(asHtml: false) } }`,
    { value },
  )
    .then(({ Media: media }) =>
      media
        ? {
            id: media.id,
            malId: media.idMal ?? null,
            english: media.title?.english?.trim() ?? "",
            native: media.title?.native?.trim() ?? "",
            romaji: media.title?.romaji?.trim() ?? "",
            description: cleanAnimeDescription(media.description ?? ""),
          }
        : null,
    )
    .catch(() => {
      textCache.delete(key);
      return null;
    });
  textCache.set(key, pending);
  return pending;
}

const cache = new Map<string, Promise<AnimeInfo | null>>();

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

  const ordered = [...parts.values()].sort((a, b) => (a.startDate || "9999").localeCompare(b.startDate || "9999")).slice(0, maxParts);
  return { current, parts: ordered };
}
