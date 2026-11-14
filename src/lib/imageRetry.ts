const retryDelaysMs = [1200, 4000, 12000];
const retriedHost = "image.tmdb.org";
const attemptMark = "kinuzaRetry";

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
      if (!(image instanceof HTMLImageElement) || !image.src.includes(retriedHost)) return;
      const attempt = Number(image.dataset[attemptMark] ?? 0);
      if (attempt >= retryDelaysMs.length) return;
      image.dataset[attemptMark] = String(attempt + 1);
      image.style.visibility = "hidden";
      const source = original(image);
      setTimeout(() => {
        if (!image.isConnected || original(image) !== source) return;
        const url = new URL(source);
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
