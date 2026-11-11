import type { MediaType } from "./tmdb";

export type ImportSource = "imdb" | "letterboxd" | "trakt" | "kinopoisk";

export type ImportMark = "seen" | "planned";

export interface ImportRow {
  title: string;
  originalTitle: string;
  year: number | null;
  type: MediaType | null;
  imdbId: string | null;
  tmdbId: number | null;
  mark: ImportMark;
  rating: number | null;
  date: number | null;
}

export interface ParsedImport {
  source: ImportSource;
  rows: ImportRow[];
  skipped: number;
}

export type ImportProblem = "empty" | "unknownFormat" | "malformed";

export class ImportError extends Error {
  problem: ImportProblem;

  constructor(problem: ImportProblem) {
    super(problem);
    this.problem = problem;
  }
}

const byteOrderMark = "﻿";
const minRating = 1;
const maxRating = 10;
const letterboxdScale = 2;
const imdbIdPattern = /^tt\d+$/;


export function decodeImportText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

function stripByteOrderMark(text: string): string {
  return text.startsWith(byteOrderMark) ? text.slice(byteOrderMark.length) : text;
}


const quote = '"';
const delimiters = [",", ";", "\t"];

function detectDelimiter(text: string): string {
  const counts = new Map(delimiters.map((delimiter) => [delimiter, 0]));
  let quoted = false;
  for (const character of text) {
    if (character === quote) quoted = !quoted;
    else if (!quoted && (character === "\n" || character === "\r")) break;
    else if (!quoted && counts.has(character)) counts.set(character, counts.get(character)! + 1);
  }
  return delimiters.reduce((best, delimiter) => (counts.get(delimiter)! > counts.get(best)! ? delimiter : best));
}

export function parseCsv(text: string): string[][] {
  const source = stripByteOrderMark(text);
  const delimiter = detectDelimiter(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const endRow = () => {
    row.push(cell);
    rows.push(row);
    row = [];
    cell = "";
  };

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character !== quote) cell += character;
      else if (source[index + 1] === quote) {
        cell += quote;
        index++;
      } else quoted = false;
    } else if (character === quote && cell === "") {
      quoted = true;
    } else if (character === delimiter) {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index++;
      endRow();
    } else {
      cell += character;
    }
  }
  if (quoted) throw new ImportError("malformed");
  if (cell !== "" || row.length > 0) endRow();
  return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}

interface Table {
  header: string[];
  records: string[][];
}

function normalizeHeader(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function toTable(rows: string[][]): Table {
  const [header, ...records] = rows;
  return { header: header.map(normalizeHeader), records };
}

function cellAt(record: string[], column: number): string {
  return column >= 0 ? (record[column] ?? "").trim() : "";
}


const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const dayFirstDatePattern = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const zonedTimestampPattern = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/;

function localTime(year: string, month: string, day: string, hours = "0", minutes = "0", seconds = "0"): number | null {
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds));
  const real = date.getMonth() === Number(month) - 1 && date.getDate() === Number(day);
  return real ? date.getTime() : null;
}

export function parseImportDate(text: string): number | null {
  const value = text.trim();
  if (!value) return null;
  if (zonedTimestampPattern.test(value)) {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  const iso = isoDatePattern.exec(value);
  if (iso) return localTime(iso[1], iso[2], iso[3], iso[4], iso[5], iso[6]);
  const dayFirst = dayFirstDatePattern.exec(value);
  if (dayFirst) return localTime(dayFirst[3], dayFirst[2], dayFirst[1], dayFirst[4], dayFirst[5], dayFirst[6]);
  return null;
}

function parseNumber(text: string): number | null {
  const match = /^(\d+(?:[.,]\d+)?)(?:\s*\/\s*\d+)?$/.exec(text.trim());
  return match ? Number(match[1].replace(",", ".")) : null;
}

function toRating(value: number | null, scale = 1): number | null {
  if (value === null) return null;
  const rating = Math.round(value * scale);
  return rating >= minRating && rating <= maxRating ? rating : null;
}

function parseYear(text: string): number | null {
  const match = /\d{4}/.exec(text);
  return match ? Number(match[0]) : null;
}

function emptyRow(): ImportRow {
  return { title: "", originalTitle: "", year: null, type: null, imdbId: null, tmdbId: null, mark: "seen", rating: null, date: null };
}


const imdbSeriesTypes = ["tvseries", "tvminiseries"];
const imdbUntrackedTypes = ["tvepisode", "videogame", "podcastseries", "podcastepisode", "musicvideo"];

function isImdb(table: Table): boolean {
  return table.header.includes("const");
}

function parseImdb(table: Table): ParsedImport {
  const column = (name: string) => table.header.indexOf(name);
  const idColumn = column("const");
  const ratingColumn = column("your rating");
  const ratedColumn = column("date rated");
  const listedColumn = column("created");
  const isList = listedColumn >= 0 || column("position") >= 0;
  const rows: ImportRow[] = [];
  let skipped = 0;

  for (const record of table.records) {
    const imdbId = cellAt(record, idColumn);
    const kind = cellAt(record, column("title type")).toLowerCase().replace(/[^a-z]/g, "");
    const rating = toRating(parseNumber(cellAt(record, ratingColumn)));
    const tracked = imdbIdPattern.test(imdbId) && !imdbUntrackedTypes.includes(kind) && (rating !== null || isList);
    if (!tracked) {
      skipped++;
      continue;
    }
    rows.push({
      ...emptyRow(),
      title: cellAt(record, column("title")),
      originalTitle: cellAt(record, column("original title")),
      year: parseYear(cellAt(record, column("year"))),
      type: kind ? (imdbSeriesTypes.includes(kind) ? "tv" : "movie") : null,
      imdbId,
      mark: rating !== null ? "seen" : "planned",
      rating,
      date: parseImportDate(cellAt(record, rating !== null ? ratedColumn : listedColumn)),
    });
  }
  return { source: "imdb", rows, skipped };
}


const watchlistNamePattern = /watch.?list|to.?watch|planned|wish|буду|budu|хочу|запланир/i;

function isLetterboxd(table: Table): boolean {
  return table.header.includes("name") && table.header.includes("letterboxd uri");
}

function parseLetterboxd(table: Table, fileName: string): ParsedImport {
  const column = (name: string) => table.header.indexOf(name);
  const ratingColumn = column("rating");
  const mark: ImportMark = ratingColumn < 0 && watchlistNamePattern.test(fileName) ? "planned" : "seen";
  const rows: ImportRow[] = [];
  let skipped = 0;

  for (const record of table.records) {
    const title = cellAt(record, column("name"));
    if (!title) {
      skipped++;
      continue;
    }
    rows.push({
      ...emptyRow(),
      title,
      year: parseYear(cellAt(record, column("year"))),
      mark,
      rating: toRating(parseNumber(cellAt(record, ratingColumn)), letterboxdScale),
      date: parseImportDate(cellAt(record, column("date"))),
    });
  }
  return { source: "letterboxd", rows, skipped };
}


const kinopoiskColumns = {
  originalTitle: [
    "оригинальное название",
    "название в оригинале",
    "альтернативное название",
    "original title",
    "originaltitle",
    "original name",
    "name original",
    "nameoriginal",
    "alternative name",
    "alternativename",
    "name en",
    "nameen",
    "name eng",
    "original",
  ],
  title: ["русское название", "название", "название фильма", "фильм", "name ru", "nameru", "name rus", "title", "name"],
  year: ["год", "год выпуска", "год производства", "year"],
  rating: ["моя оценка", "ваша оценка", "оценка", "my rating", "myrating", "your rating", "user rating", "userrating", "my vote", "vote", "rating"],
  date: ["дата оценки", "дата и время", "дата", "date rated", "rated at", "vote date", "date"],
  type: ["тип", "type"],
  imdbId: ["imdb id", "imdbid", "imdb"],
};

const kinopoiskStems = {
  originalTitle: ["оригинал", "original"],
  title: ["назван", "title", "name"],
  year: ["год", "year"],
  rating: ["оценк", "my rating", "vote"],
  date: ["дата", "date"],
};
const unrelatedStems = ["кп", "kp", "кинопоиск", "kinopoisk", "imdb", "рейтинг", "средн", "кол", "count", "выход", "премьер", "release", "premiere"];

const seriesTypePattern = /сериал|series|show/i;
const filmTypePattern = /фильм|мульт|movie|film|cartoon/i;

function findColumn(header: string[], names: string[], stems: string[] = [], taken: number[] = []): number {
  for (const name of names) {
    const index = header.indexOf(name);
    if (index >= 0 && !taken.includes(index)) return index;
  }
  return header.findIndex(
    (name, index) =>
      !taken.includes(index) && stems.some((stem) => name.includes(stem)) && !unrelatedStems.some((stem) => name.includes(stem)),
  );
}

function holdsPersonalRatings(records: string[][], column: number): boolean {
  return records.every((record) => {
    const value = parseNumber(cellAt(record, column));
    return value === null || Number.isInteger(value);
  });
}

function parseKinopoisk(table: Table, fileName: string): ParsedImport | null {
  const { header, records } = table;
  const originalColumn = findColumn(header, kinopoiskColumns.originalTitle, kinopoiskStems.originalTitle);
  const titleColumn = findColumn(header, kinopoiskColumns.title, kinopoiskStems.title, [originalColumn]);
  const yearColumn = findColumn(header, kinopoiskColumns.year, kinopoiskStems.year);
  const foundRatingColumn = findColumn(header, kinopoiskColumns.rating, kinopoiskStems.rating);
  const ratingColumn = foundRatingColumn >= 0 && holdsPersonalRatings(records, foundRatingColumn) ? foundRatingColumn : -1;
  const dateColumn = findColumn(header, kinopoiskColumns.date, kinopoiskStems.date);
  const typeColumn = findColumn(header, kinopoiskColumns.type);
  const imdbColumn = findColumn(header, kinopoiskColumns.imdbId);

  const recognised = (titleColumn >= 0 || originalColumn >= 0) && (yearColumn >= 0 || ratingColumn >= 0);
  if (!recognised) return null;

  const isWatchlist = watchlistNamePattern.test(fileName);
  const rows: ImportRow[] = [];
  let skipped = 0;

  for (const record of records) {
    const title = cellAt(record, titleColumn);
    const originalTitle = cellAt(record, originalColumn);
    const imdbId = cellAt(record, imdbColumn);
    if (!title && !originalTitle) {
      skipped++;
      continue;
    }
    const kind = cellAt(record, typeColumn);
    const rating = toRating(parseNumber(cellAt(record, ratingColumn)));
    rows.push({
      ...emptyRow(),
      title: title || originalTitle,
      originalTitle: title ? originalTitle : "",
      year: parseYear(cellAt(record, yearColumn)),
      type: seriesTypePattern.test(kind) ? "tv" : filmTypePattern.test(kind) ? "movie" : null,
      imdbId: imdbIdPattern.test(imdbId) ? imdbId : null,
      mark: rating === null && isWatchlist ? "planned" : "seen",
      rating,
      date: parseImportDate(cellAt(record, dateColumn)),
    });
  }
  return { source: "kinopoisk", rows, skipped };
}


type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function traktMedia(item: unknown): { media: Json; type: MediaType } | null {
  if (!isObject(item)) return null;
  if (isObject(item.movie)) return { media: item.movie, type: "movie" };
  if (isObject(item.show)) return { media: item.show, type: "tv" };
  return null;
}

function isTrakt(data: unknown): data is unknown[] {
  return Array.isArray(data) && data.some((item) => traktMedia(item) !== null);
}

function parseTrakt(items: unknown[]): ParsedImport {
  const rows: ImportRow[] = [];
  let skipped = 0;

  for (const item of items) {
    const found = traktMedia(item);
    const entry = item as Json;
    if (!found || isObject(entry.episode) || isObject(entry.season)) {
      skipped++;
      continue;
    }
    const { media, type } = found;
    const ids = isObject(media.ids) ? media.ids : {};
    const rating = typeof entry.rating === "number" ? toRating(entry.rating) : null;
    const seenAt = [entry.rated_at, entry.watched_at, entry.last_watched_at].find((value) => typeof value === "string");
    const listedAt = typeof entry.listed_at === "string" ? entry.listed_at : undefined;
    const title = typeof media.title === "string" ? media.title : "";
    const tmdbId = typeof ids.tmdb === "number" ? ids.tmdb : null;
    const imdbId = typeof ids.imdb === "string" && imdbIdPattern.test(ids.imdb) ? ids.imdb : null;

    const seen = rating !== null || seenAt !== undefined;
    const usable = (seen || listedAt !== undefined) && (tmdbId !== null || imdbId !== null || title !== "");
    if (!usable) {
      skipped++;
      continue;
    }
    rows.push({
      ...emptyRow(),
      title,
      year: typeof media.year === "number" ? media.year : null,
      type,
      imdbId,
      tmdbId,
      mark: seen ? "seen" : "planned",
      rating,
      date: parseImportDate(String(seenAt ?? listedAt ?? "")),
    });
  }
  return { source: "trakt", rows, skipped };
}


function parseJsonExport(content: string): ParsedImport {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    throw new ImportError("malformed");
  }
  if (Array.isArray(data) && data.length === 0) throw new ImportError("empty");
  if (!isTrakt(data)) throw new ImportError("unknownFormat");
  return parseTrakt(data);
}

export function parseImportFile(text: string, fileName = ""): ParsedImport {
  const content = stripByteOrderMark(text).trim();
  if (!content) throw new ImportError("empty");
  if (content.startsWith("[") || content.startsWith("{")) return parseJsonExport(content);

  const rows = parseCsv(content);
  const table = toTable(rows);
  const parsed = isImdb(table) ? parseImdb(table) : isLetterboxd(table) ? parseLetterboxd(table, fileName) : parseKinopoisk(table, fileName);
  if (!parsed) throw new ImportError("unknownFormat");
  if (table.records.length === 0) throw new ImportError("empty");
  return parsed;
}
