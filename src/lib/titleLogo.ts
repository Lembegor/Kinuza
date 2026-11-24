import { useEffect, useState } from "react";
import { cachedCatalog } from "./persistentCache";
import { catalogImageBases, catalogLanguage, currentImageBase, tmdb, type MediaType, type TitleLogo } from "./tmdb";

const logosMaxAgeMs = 7 * 86_400_000;
const darkBelow = 0.3;
const sampleWidth = 72;
const attemptTimeoutMs = 8000;
const staggerMs = 900;
let workingBase: string | null = null;

export type LogoTone = "light" | "dark" | "unknown";

export interface ShownLogo {
  url: string;
  aspect: number;
  native: boolean;
  tone: LogoTone;
}

interface Candidate {
  file: string;
  aspect: number;
  native: boolean;
}

interface Loaded {
  url: string;
  tone: LogoTone;
}

const loaded = new Map<string, Loaded>();
const failed = new Set<string>();
const pending = new Map<string, Promise<Loaded | null>>();
const lists = new Map<string, TitleLogo[]>();

function uiLanguage(): string {
  return catalogLanguage().slice(0, 2);
}

function better(a: TitleLogo, b: TitleLogo): number {
  return b.score - a.score || b.votes - a.votes;
}

function fileOf(logo: TitleLogo): string {
  return `/${logo.path.endsWith(".svg") ? "original" : "w500"}${logo.path}`;
}

export function pickLogo(logos: TitleLogo[], ui: string, original: string): Candidate | null {
  const order = [ui, original, "en", null];
  for (const language of order) {
    const group = logos.filter((logo) => logo.language === language).sort(better);
    const best = group.find((logo) => !failed.has(fileOf(logo)));
    if (best) return { file: fileOf(best), aspect: best.aspect, native: language === ui };
  }
  return null;
}

function toneOf(image: HTMLImageElement, aspect: number): LogoTone {
  try {
    const width = sampleWidth;
    const height = Math.max(1, Math.round(sampleWidth / aspect));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return "unknown";
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let light = 0;
    let weight = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3] / 255;
      if (alpha < 0.4) continue;
      light += ((0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]) / 255) * alpha;
      weight += alpha;
    }
    if (weight < 4) return "unknown";
    return light / weight < darkBelow ? "dark" : "light";
  } catch {
    return "unknown";
  }
}

type Outcome = HTMLImageElement | "error" | "timeout";

function fetchImage(url: string, shared: boolean): Promise<Outcome> {
  return new Promise((resolve) => {
    const image = new Image();
    const timer = setTimeout(() => {
      image.src = "";
      resolve("timeout");
    }, attemptTimeoutMs);
    if (shared) image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      resolve("error");
    };
    image.src = url;
  });
}

async function fetchFrom(base: string, candidate: Candidate): Promise<Loaded | null> {
  const url = `${base}${candidate.file}`;
  const shared = await fetchImage(url, true);
  if (typeof shared !== "string") return { url, tone: toneOf(shared, candidate.aspect) };
  if (shared === "timeout") return null;
  const plain = await fetchImage(url, false);
  return typeof plain !== "string" ? { url, tone: "unknown" } : null;
}

function fetchLogo(candidate: Candidate): Promise<Loaded | null> {
  const first = workingBase ?? currentImageBase();
  const bases = [first, ...catalogImageBases().filter((base) => base !== first)];
  return new Promise((resolve) => {
    let done = false;
    let started = 0;
    let finished = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const launch = (): void => {
      if (done || started >= bases.length) return;
      const base = bases[started++];
      clearTimeout(timer);
      timer = setTimeout(launch, staggerMs);
      void fetchFrom(base, candidate).then((result) => {
        finished += 1;
        if (done) return;
        if (result) {
          done = true;
          clearTimeout(timer);
          workingBase = base;
          resolve(result);
          return;
        }
        if (workingBase === base) workingBase = null;
        if (started < bases.length) launch();
        else if (finished >= bases.length) {
          done = true;
          resolve(null);
        }
      });
    };
    launch();
  });
}

function loadLogo(candidate: Candidate): Promise<Loaded | null> {
  const known = loaded.get(candidate.file);
  if (known) return Promise.resolve(known);
  if (failed.has(candidate.file)) return Promise.resolve(null);
  const running = pending.get(candidate.file);
  if (running) return running;
  const promise = fetchLogo(candidate)
    .then((result) => {
      if (result) loaded.set(candidate.file, result);
      else failed.add(candidate.file);
      return result;
    })
    .finally(() => pending.delete(candidate.file));
  pending.set(candidate.file, promise);
  return promise;
}

function shownOf(candidate: Candidate, result: Loaded): ShownLogo {
  return { url: result.url, tone: result.tone, aspect: candidate.aspect, native: candidate.native };
}

function listKey(type: MediaType, id: number): string {
  return `${uiLanguage()}:${type}:${id}`;
}

function logosOf(type: MediaType, id: number, original: string): Promise<TitleLogo[]> {
  const key = listKey(type, id);
  return cachedCatalog(`logos:${type}:${id}`, logosMaxAgeMs, () => tmdb.logos(type, id, original)).then((logos) => {
    lists.set(key, logos);
    return logos;
  });
}

function settled(type: MediaType, id: number, original: string): ShownLogo | null | undefined {
  const logos = lists.get(listKey(type, id));
  if (!logos) return undefined;
  const candidate = pickLogo(logos, uiLanguage(), original);
  if (!candidate) return null;
  const result = loaded.get(candidate.file);
  return result ? shownOf(candidate, result) : undefined;
}

export function warmTitleLogo(type: MediaType, id: number, original: string): void {
  void logosOf(type, id, original)
    .then((logos) => {
      const candidate = pickLogo(logos, uiLanguage(), original);
      if (candidate) void loadLogo(candidate);
    })
    .catch(() => undefined);
}

export function useTitleLogo(type: MediaType | null, id: number | null, original: string): ShownLogo | null {
  const key = type && id ? listKey(type, id) : "";
  const [shown, setShown] = useState<{ key: string; logo: ShownLogo | null }>({ key: "", logo: null });

  useEffect(() => {
    if (!type || !id) return;
    const ready = settled(type, id, original);
    if (ready !== undefined) {
      setShown({ key, logo: ready });
      return;
    }
    let alive = true;
    const attempt = (logos: TitleLogo[]): void => {
      const candidate = pickLogo(logos, uiLanguage(), original);
      if (!candidate) {
        setShown({ key, logo: null });
        return;
      }
      void loadLogo(candidate).then((result) => {
        if (!alive) return;
        if (result) setShown({ key, logo: shownOf(candidate, result) });
        else attempt(logos);
      });
    };
    logosOf(type, id, original)
      .then((logos) => alive && attempt(logos))
      .catch(() => alive && setShown({ key, logo: null }));
    return () => {
      alive = false;
    };
  }, [key, type, id, original]);

  if (shown.key === key) return shown.logo;
  return type && id ? (settled(type, id, original) ?? null) : null;
}

export function logoBox(aspect: number, area: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const width = Math.min(maxWidth, Math.sqrt(area * aspect), maxHeight * aspect);
  return { width: Math.round(width), height: Math.round(width / aspect) };
}

export function needsCaption(logo: ShownLogo, title: string, originalTitle: string): boolean {
  if (logo.native) return false;
  return title.trim().toLocaleLowerCase() !== originalTitle.trim().toLocaleLowerCase();
}
