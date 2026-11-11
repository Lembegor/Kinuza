// Finds freely available copies of a film in the Internet Archive (archive.org) through its
// public search API. Every item there comes with an official .torrent file.

const searchEndpoint = "https://archive.org/advancedsearch.php";
const downloadBase = "https://archive.org/download";
const detailsBase = "https://archive.org/details";

/** Curated film collections of the Archive: public-domain and freely licensed movies. */
const collections = ["feature_films", "silent_films", "SciFi_Horror", "Comedy_Films", "Film_Noir", "classic_cartoons"];
const requestedRows = 25;
const maxResults = 6;
/** Release years in the Archive and in the catalog may differ by one. */
const yearTolerance = 1;

export interface ArchiveItem {
  identifier: string;
  title: string;
  year: string;
  downloads: number;
  /** Address of the item's official torrent; the torrent engine fetches it directly. */
  torrentUrl: string;
  pageUrl: string;
}

interface ArchiveDoc {
  identifier: string;
  title?: string;
  year?: number | string;
  downloads?: number;
}

/** Lower-cases and strips punctuation so "Charade!" and "charade" compare equal. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function buildQuery(title: string): string {
  // Punctuation would be read as search syntax, so only the words are sent.
  const words = normalize(title);
  return `title:(${words}) AND mediatype:movies AND collection:(${collections.join(" OR ")})`;
}

function matchesYear(doc: ArchiveDoc, year: string): boolean {
  const wanted = Number(year);
  const found = Number(doc.year);
  if (!wanted || !found) return true;
  return Math.abs(wanted - found) <= yearTolerance;
}

/**
 * Searches the Archive for a film by its original title. Results whose year contradicts the
 * catalog are dropped (a remake is a different film); the most downloaded copies come first.
 */
export async function searchArchive(originalTitle: string, year: string): Promise<ArchiveItem[]> {
  const wantedTitle = normalize(originalTitle);
  if (!wantedTitle) return [];

  const params = new URLSearchParams({ q: buildQuery(originalTitle), rows: String(requestedRows), page: "1", output: "json" });
  for (const field of ["identifier", "title", "year", "downloads"]) params.append("fl[]", field);
  params.append("sort[]", "downloads desc");

  const response = await fetch(`${searchEndpoint}?${params}`);
  if (!response.ok) throw new Error(`archive_${response.status}`);
  const docs: ArchiveDoc[] = (await response.json()).response?.docs ?? [];

  return docs
    .filter((doc) => normalize(doc.title ?? "").includes(wantedTitle) && matchesYear(doc, year))
    .slice(0, maxResults)
    .map((doc) => ({
      identifier: doc.identifier,
      title: doc.title ?? doc.identifier,
      year: doc.year ? String(doc.year) : "",
      downloads: doc.downloads ?? 0,
      torrentUrl: `${downloadBase}/${encodeURIComponent(doc.identifier)}/${encodeURIComponent(doc.identifier)}_archive.torrent`,
      pageUrl: `${detailsBase}/${encodeURIComponent(doc.identifier)}`,
    }));
}
