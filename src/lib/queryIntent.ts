import type { TasteFilters } from "./backend";

export type IntentChip =
  | { kind: "like"; text: string }
  | { kind: "genre"; id: number; without?: boolean }
  | { kind: "type"; value: "movie" | "tv" | "anime" | "cartoon" }
  | { kind: "length"; value: "short" | "long" }
  | { kind: "era"; value: "new" | "old" }
  | { kind: "decade"; from: number; to: number }
  | { kind: "country"; code: string };

export interface QueryIntent {
  like: string | null;
  filters: TasteFilters;
  chips: IntentChip[];
  meaningful: boolean;
}

const genreWords: [RegExp, number][] = [
  [/^(комеди|комеді|comed|смешн|смішн|funny)/, 35],
  [/^(ужас|ужастик|хоррор|жах|horror|scary|страшн)/, 27],
  [/^(триллер|трилер|thriller)/, 53],
  [/^(драм|drama)/, 18],
  [/^(фантастик|фантастичн|sci-?fi|science)/, 878],
  [/^(фэнтези|фентез|fantasy)/, 14],
  [/^(боевик|бойовик|экшн|екшн|action)/, 28],
  [/^(приключ|пригод|adventure)/, 12],
  [/^(детектив|detective|mystery|мистик|містик|загадк)/, 9648],
  [/^(криминал|кримінал|crime|гангстер|gangster)/, 80],
  [/^(романтик|романтич|мелодрам|romance|romantic|любов|кохан|love)/, 10749],
  [/^(военн|воєнн|війн|войн|war)/, 10752],
  [/^(вестерн|western)/, 37],
  [/^(документал|documentar)/, 99],
  [/^(семейн|сімейн|family|семьи|семью|родин)/, 10751],
  [/^(историческ|історичн|history|historical)/, 36],
  [/^(музыкальн|музичн|musical|music)/, 10402],
];

const countryWords: [RegExp, string, string?][] = [
  [/^(корейск|корейськ|korean)/, "KR", "ko"],
  [/^(японск|японськ|japanese)/, "JP", "ja"],
  [/^(китайск|китайськ|chinese)/, "CN", "zh"],
  [/^(французск|французьк|french)/, "FR"],
  [/^(итальянск|італійськ|italian)/, "IT"],
  [/^(испанск|іспанськ|spanish)/, "ES"],
  [/^(британск|британськ|английск|англійськ|british|english)/, "GB"],
  [/^(американск|американськ|american|голливудск|голлівудськ|hollywood)/, "US"],
  [/^(советск|радянськ|soviet)/, "SU"],
  [/^(русск|российск|російськ|russian)/, "RU"],
  [/^(украинск|українськ|ukrainian)/, "UA"],
  [/^(индийск|індійськ|indian|болливуд|боллівуд|bollywood)/, "IN"],
  [/^(турецк|турецьк|turkish)/, "TR"],
  [/^(немецк|німецьк|german)/, "DE"],
  [/^(скандинавск|скандинавськ|шведск|шведськ|swedish|danish|датск|датськ)/, "SE"],
];

const likePattern = /(?:^|\s)(?:как|типа|вроде|похож(?:ее|ий|ие|е)? на|в духе|як|схож(?:е|ий|і)? на|на кшталт|в дусі|like|similar to)\s+(.+?)(?=\s*(?:,|\bно\b|\bале\b|\bbut\b|\bтолько\b|\bлише\b|$))/i;
const decadePattern = /(?:^|\s)(?:(19|20)?(\d)0)\s*-?\s*(?:х|х годов|х років|s)(?=\s|$|,)/i;
const yearPattern = /(?:^|\s)((?:19|20)\d{2})(?=\s|$|,)/;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}-]+/u)
    .filter(Boolean);
}

const negation = /^(без|не|without|no|кроме|крім)$/;

export function parseQuery(query: string, thisYear: number = new Date().getFullYear()): QueryIntent {
  const chips: IntentChip[] = [];
  const filters: TasteFilters = {};
  let rest = query.trim();
  let like: string | null = null;
  const likeMatch = likePattern.exec(rest);
  if (likeMatch) {
    like = likeMatch[1].replace(/[«»"“”„]/g, "").trim() || null;
    if (like) {
      chips.push({ kind: "like", text: like });
      rest = rest.replace(likeMatch[0], " ");
    }
  }

  const decade = decadePattern.exec(rest);
  if (decade) {
    const century = decade[1] ? Number(decade[1]) * 100 : Number(decade[2]) >= 3 ? 1900 : 2000;
    const from = century + Number(decade[2]) * 10;
    filters.minYear = from;
    filters.maxYear = from + 9;
    chips.push({ kind: "decade", from, to: from + 9 });
    rest = rest.replace(decade[0], " ");
  } else {
    const year = yearPattern.exec(rest);
    if (year) {
      const value = Number(year[1]);
      if (value >= 1900 && value <= thisYear + 1) {
        filters.minYear = value;
        filters.maxYear = value;
        chips.push({ kind: "decade", from: value, to: value });
        rest = rest.replace(year[0], " ");
      }
    }
  }

  const tokens = words(rest);
  const genres: number[] = [];
  const without: number[] = [];
  tokens.forEach((token, index) => {
    const negated = index > 0 && negation.test(tokens[index - 1]);
    const genre = genreWords.find(([pattern]) => pattern.test(token));
    if (genre) {
      if (negated) {
        if (!without.includes(genre[1])) without.push(genre[1]);
      } else if (!genres.includes(genre[1])) genres.push(genre[1]);
      return;
    }
    if (/^(дорам|dorama|k-?drama)/.test(token) && !negated) {
      filters.kind = "tv";
      filters.countries = [...(filters.countries ?? []), "KR", "CN", "JP", "TW", "TH"];
      chips.push({ kind: "type", value: "tv" });
      return;
    }
    const country = countryWords.find(([pattern]) => pattern.test(token));
    if (country && !negated) {
      filters.countries = [...(filters.countries ?? []), country[1]];
      if (country[1] === "SU") filters.maxYear = Math.min(filters.maxYear ?? 1991, 1991);
      chips.push({ kind: "country", code: country[1] });
      return;
    }
    if (/^(сериал|серіал|series)/.test(token)) {
      filters.kind = "tv";
      chips.push({ kind: "type", value: "tv" });
    } else if (/^(фильм|фільм|кино|кіно|movie|movies|film|films)$/.test(token) || /^(фильм|фільм)/.test(token)) {
      filters.kind = "movie";
      chips.push({ kind: "type", value: "movie" });
    } else if (/^(аниме|аніме|anime)$/.test(token)) {
      filters.anime = true;
      chips.push({ kind: "type", value: "anime" });
    } else if (/^(мульт|мультфильм|мультфільм|мультик|cartoon|animated|анимац|анімац)/.test(token)) {
      if (!genres.includes(16)) genres.push(16);
      filters.anime = false;
      chips.push({ kind: "type", value: "cartoon" });
    } else if (/^(коротк|короче|недолг|недовг|short)/.test(token)) {
      chips.push({ kind: "length", value: "short" });
      filters.maxRuntime = 100;
    } else if (/^(длинн|довг|длиннее|long|epic|эпическ|епічн)/.test(token)) {
      chips.push({ kind: "length", value: "long" });
      filters.minRuntime = 140;
    } else if (/^(нов|свеж|свіж|new|recent|latest)/.test(token) && filters.minYear === undefined) {
      filters.minYear = thisYear - 3;
      chips.push({ kind: "era", value: "new" });
    } else if (/^(стар|классик|класик|old|classic|ретро|retro)/.test(token) && filters.maxYear === undefined) {
      filters.maxYear = 1999;
      chips.push({ kind: "era", value: "old" });
    }
  });
  if (filters.kind === "tv" && filters.maxRuntime !== undefined) filters.maxRuntime = 30;
  if (filters.kind === "tv" && filters.minRuntime !== undefined) filters.minRuntime = 45;
  if (genres.length > 0) filters.genres = genres;
  if (without.length > 0) filters.withoutGenres = without;
  for (const id of genres) if (id !== 16) chips.push({ kind: "genre", id });
  for (const id of without) chips.push({ kind: "genre", id, without: true });

  const meaningful = like !== null ? chips.length >= 1 : chips.length >= 1 && tokens.length <= 8 && filterCount(filters) >= 1 && looksLikeRequest(tokens, chips);
  return { like, filters, chips, meaningful };
}

function filterCount(filters: TasteFilters): number {
  return Object.values(filters).filter((value) => value !== undefined && !(Array.isArray(value) && value.length === 0)).length;
}

function looksLikeRequest(tokens: string[], chips: IntentChip[]): boolean {
  const understood = chips.length;
  const filler = tokens.filter((token) => /^(и|й|та|с|з|про|для|на|в|у|the|a|and|with|about|for|что|що|посмотреть|подивитись|подивитися|watch|хочу|want|найди|знайди|find|покажи|show|me|мне|мені|something|что-нибудь|щось|годн|хорош|добр|good|best|лучш|найкращ|без|не)/.test(token)).length;
  return understood + filler >= Math.ceil(tokens.length * 0.6);
}
