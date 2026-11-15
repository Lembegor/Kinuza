import { catalogImageBases, currentImageBase, noteCatalogTrouble } from "./tmdb";

let failedPictures = 0;
let loggedAt = 0;
const logEveryMs = 60_000;

const retryDelaysMs = [1200, 4000, 12000];
const attemptMark = "kinuzaRetry";

function catalogPath(source: string): string | null {
  for (const base of catalogImageBases()) {
    if (source.startsWith(`${base}/`)) return source.slice(base.length).split("?")[0];
  }
  return null;
}

function original(image: HTMLImageElement): string {
  const url = new URL(image.currentSrc || image.src);
  url.searchParams.delete("retry");
  return url.toString();
}

export function retryFailedImages(): void {
  document.addEventListener(
    "error",
    (event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || catalogPath(image.src) === null) return;
      const attempt = Number(image.dataset[attemptMark] ?? 0);
      noteCatalogTrouble();
      failedPictures += 1;
      if (Date.now() - loggedAt > logEveryMs) {
        loggedAt = Date.now();
        const host = new URL(image.src).host;
        void import("./backend").then(({ backend }) => backend.appLog(`catalog: ${failedPictures} pictures failed so far, last from ${host} (try ${attempt + 1})`)).catch(() => undefined);
      }
      if (attempt >= retryDelaysMs.length) return;
      image.dataset[attemptMark] = String(attempt + 1);
      image.style.visibility = "hidden";
      const source = original(image);
      setTimeout(() => {
        if (!image.isConnected || original(image) !== source) return;
        const path = catalogPath(source);
        const bases = catalogImageBases();
        const base = bases[(bases.indexOf(currentImageBase()) + attempt) % bases.length];
        const url = new URL(path ? `${base}${path}` : source);
        url.searchParams.set("retry", String(attempt + 1));
        image.src = url.toString();
      }, retryDelaysMs[attempt]);
    },
    true,
  );
  document.addEventListener(
    "load",
    (event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !image.dataset[attemptMark]) return;
      image.style.visibility = "";
      delete image.dataset[attemptMark];
    },
    true,
  );
}
