// Reads what other services export — ratings, watched films, watchlists — into one shape the
// app can match against the catalog. Pure: no network, no storage, no interface texts.

import type { MediaType } from "./tmdb";

export type ImportSource = "imdb" | "letterboxd" | "trakt" | "kinopoisk";

/** What a file says about a title: the user has seen it (rated or not), or means to. */
export type ImportMark = "seen" | "planned";

export interface ImportRow {
  /** The title as the file names it; empty when the file only has an id. */
  title: string;
  /** The name in the original language, when the file has it next to a translated one. */
  originalTitle: string;
  year: number | null;
  /** Film or series, when the file tells. */
  type: MediaType | null;
  /** "tt1375666". */
  imdbId: string | null;
  tmdbId: number | null;
  mark: ImportMark;
  /** 1..10, whatever scale the service uses. */
  rating: number | null;
  /** When the user rated, watched or listed the title, in milliseconds; null when the file has no date. */
  date: number | null;
}

export interface ParsedImport {
  source: ImportSource;
  rows: ImportRow[];
  /** Rows that cannot become a title in the list: single episodes, rows without a name or an id. */
  skipped: number;
}

/** Why a file could not be imported at all. */
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
/** Letterboxd rates in half stars up to five. */
const letterboxdScale = 2;
const imdbIdPattern = /^tt\d+$/;

/* Text */

/**
 * The file's bytes as text. Exports are UTF-8 as a rule, but tools that save Kinopoisk ratings
 * for Excel write UTF-16 or the Windows Cyrillic code page.
 */
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

/* CSV */

const quote = '"';
/** Comma by the standard; semicolon and tab are what spreadsheet programs save in Russian locales. */
const delimiters = [",", ";", "\t"];

/** The delimiter the header line uses most, counted outside quotes. */
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

/**
 * Rows of a CSV file as cells. Understands quoted cells with delimiters, line breaks and doubled
 * quotes inside, a byte order mark, and both kinds of line ending; blank lines are dropped.
 * Throws `ImportError("malformed")` when a quoted cell is never closed.
 */
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
      // A quote opens a quoted cell only at its start; elsewhere it is an ordinary character.
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

/** A CSV file as a header and records; column names are compared lower-cased, with `_` and `-` as spaces. */
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

/** Reads one column of a record by the column's position; empty when the record is shorter or the column is absent. */
function cellAt(record: string[], column: number): string {
  return column >= 0 ? (record[column] ?? "").trim() : "";
}

/* Values */

const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
/** Day first, as Kinopoisk and Russian spreadsheets write dates: "05.03.2021" or "05.03.2021, 14:25". */
const dayFirstDatePattern = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
/** A full timestamp that names its time zone, as Trakt writes them. */
const zonedTimestampPattern = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/;

function localTime(year: string, month: string, day: string, hours = "0", minutes = "0", seconds = "0"): number | null {
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds));
  // `Date` rolls an impossible day over into the next month; such a value is not a date.
  const real = date.getMonth() === Number(month) - 1 && date.getDate() === Number(day);
  return real ? date.getTime() : null;
}

/**
 * A date from an export, in milliseconds. A date without a time means the start of that day in
 * local time: the earliest moment it can stand for, so it never outranks a change made in the
 * app later the same day.
 */
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

/** "8", "8.0", "8,5" or "9/10" as a number; null for an empty cell or a dash. */
function parseNumber(text: string): number | null {
  const match = /^(\d+(?:[.,]\d+)?)(?:\s*\/\s*\d+)?$/.exec(text.trim());
  return match ? Number(match[1].replace(",", ".")) : null;
}

/** A rating on the app's scale, or null when the value is not a rating at all. */
function toRating(value: number | null, scale = 1): number | null {
  if (value === null) return null;
  const rating = Math.round(value * scale);
  return rating >= minRating && rating <= maxRating ? rating : null;
}

/** The first year in the cell: series are often given as a range, "2008–2013". */
function parseYear(text: string): number | null {
  const match = /\d{4}/.exec(text);
  return match ? Number(match[0]) : null;
}

function emptyRow(): ImportRow {
  return { title: "", originalTitle: "", year: null, type: null, imdbId: null, tmdbId: null, mark: "seen", rating: null, date: null };
}

/* IMDb */

/** IMDb's kinds of title that are series here; the other kinds that can be tracked are films. */
const imdbSeriesTypes = ["tvseries", "tvminiseries"];
/** Kinds that have no page in the catalog of films and series. */
const imdbUntrackedTypes = ["tvepisode", "videogame", "podcastseries", "podcastepisode", "musicvideo"];

function isImdb(table: Table): boolean {
  return table.header.includes("const");
}

function parseImdb(table: Table): ParsedImport {
  const column = (name: string) => table.header.indexOf(name);
  const idColumn = column("const");
  const ratingColumn = column("your rating");
  const ratedColumn = column("date rated");
  // Only lists (the watchlist among them) say when a title was added to them.
  const listedColumn = column("created");
  const isList = listedColumn >= 0 || column("position") >= 0;
  const rows: ImportRow[] = [];
  let skipped = 0;

  for (const record of table.records) {
    const imdbId = cellAt(record, idColumn);
    // "tvSeries" in older exports, "TV Series" in newer ones.
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

/* Letterboxd */

/** The watchlist has the same columns as the list of watched films; only the file's name tells them apart. */
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

/* Kinopoisk */

/**
 * Kinopoisk has no export of its own; the tools that save its ratings each name the columns
 * their own way. Names to look for, the most telling first.
 */
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

/** Parts of a column name that give it away when the whole name is not one of the known ones. */
const kinopoiskStems = {
  originalTitle: ["оригинал", "original"],
  title: ["назван", "title", "name"],
  year: ["год", "year"],
  rating: ["оценк", "my rating", "vote"],
  date: ["дата", "date"],
};
/**
 * Columns that look like the ones wanted but hold something else: the site's rating or its count
 * of votes rather than the user's own rating, the day of the premiere rather than of the rating.
 */
const unrelatedStems = ["кп", "kp", "кинопоиск", "kinopoisk", "imdb", "рейтинг", "средн", "кол", "count", "выход", "премьер", "release", "premiere"];

const seriesTypePattern = /сериал|series|show/i;
const filmTypePattern = /фильм|мульт|movie|film|cartoon/i;

/** Position of the column for one kind of value: by a known name first, then by a telling part of the name. */
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

/** The user's own ratings on Kinopoisk are whole numbers; a column with fractions is the site's average. */
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

  // A table with names but neither years nor ratings is not an export of anyone's films.
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

/* Trakt */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The film or series an item of a Trakt export is about. */
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
    // A rated or watched episode or season says nothing certain about the series as a whole.
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
    // Neither rated, watched nor listed (a collection of owned discs, say), or nothing to find it by.
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

/* Entry point */

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

/**
 * Recognises whose export the file is — IMDb, Letterboxd, Trakt or a Kinopoisk table — by its
 * contents and reads its rows. `fileName` only settles what the contents cannot: whether a list
 * without ratings is a watchlist. Throws `ImportError` when the file is empty, cut short or not
 * an export the app knows.
 */
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
