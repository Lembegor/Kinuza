import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ExternalLink, HardDrive, LoaderCircle, LogIn, Monitor, Search, Server, Sparkles } from "lucide-react";
import { animeInfo } from "../lib/anilist";
import { isDesktop, type TorrentPreview } from "../lib/backend";
import { t, useT, type MessageKey } from "../lib/i18n";
import {
  isVideoRelease,
  originalLanguageMark,
  parseSize,
  parseTrackerRelease,
  qualityFromSize,
  qualityRank,
  type ReleaseAudioTrack,
  type ReleaseScope,
  type TrackerRelease,
  type VoiceKind,
} from "../lib/parse";
import { isServerError, rutracker, rutrackerErrors, serverProblemOf, trackerRoute, type RutrackerItem, type ServerProblem, type TrackerRoute, type VideoSize } from "../lib/rutracker";
import { buildProfiles, matchSeasons, seasonQueries, taskKey, type SearchTask, type SeasonMatch, type SeasonProfile } from "../lib/seasonSearch";
import { animeTrackerNames } from "../lib/localized";
import { tmdb, type ShowNames } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { useSettings, type TrackerSort } from "../state/settings";
import { useUi, type AddSourceTarget } from "../state/ui";
import { LanguageFlags } from "./LanguageFlags";

const pageLookupLimit = 20;
const anySeason = 0;
const slowSearchMs = 9000;
const mainQueryPages = 4;
const extraQueryPages = 2;
const seasonQueryLimit = 14;
const seasonChipNameLength = 36;

const resolutionFilters = [
  { id: "2160", label: "4K", minRank: 2000 },
  { id: "1080", label: "1080p", minRank: 1000 },
  { id: "720", label: "720p", minRank: 700 },
  { id: "sd", label: "SD", minRank: 1 },
] as const;

const voiceFilters: { id: string; label: MessageKey; matches: (release: TrackerRelease) => boolean }[] = [
  { id: "dub", label: "tracker.filter.dub", matches: (release) => release.audio.some((track) => track.kind === "dub") },
  { id: "original", label: "tracker.filter.original", matches: (release) => release.audio.some((track) => track.kind === "original") },
  { id: "subtitles", label: "common.subtitles", matches: (release) => release.subtitles !== null },
];

const sortOptions: { id: TrackerSort; label: MessageKey }[] = [
  { id: "best", label: "tracker.sort.best" },
  { id: "seeds", label: "tracker.sort.seeds" },
  { id: "sizeDesc", label: "tracker.sort.sizeDesc" },
  { id: "sizeAsc", label: "tracker.sort.sizeAsc" },
];

const voiceKindLabels: Record<VoiceKind, MessageKey> = {
  dub: "tracker.voice.dub",
  mvo: "tracker.voice.mvo",
  dvo: "tracker.voice.dvo",
  avo: "tracker.voice.avo",
  vo: "tracker.voice.vo",
  original: "tracker.voice.original",
};

const defaultWantedResolution = 1080;
const scoreWeights = { resolution: 1.5, audio: 2, subtitles: 1.2, seeds: 0.8 };
const unknownResolutionPenalty = 1.5;
const noSeedsPenalty = 5;

interface Wanted {
  resolution: number;
  audio: string;
  subtitles: string;
}

function releaseScore(row: ReleaseRow, wanted: Wanted, originalLanguage: string): number {
  if (!row.isVideo) return -Infinity;
  const rank = qualityRank(row.resolution);
  const resolutionFit = rank > 0 ? -Math.abs(Math.log2(rank / wanted.resolution)) : -unknownResolutionPenalty;
  const audio = row.release.audioLanguages.map((code) => (code === originalLanguageMark ? originalLanguage : code));
  const understood = audio.includes(wanted.audio)
    ? scoreWeights.audio
    : row.release.subtitleLanguages.includes(wanted.subtitles)
      ? scoreWeights.subtitles
      : 0;
  const seeded = row.item.seeds === 0 ? -noSeedsPenalty : Math.log10(row.item.seeds + 1) * scoreWeights.seeds;
  return resolutionFit * scoreWeights.resolution + understood + seeded;
}

interface ReleaseRow {
  item: RutrackerItem;
  release: TrackerRelease;
  isVideo: boolean;
  resolution: string;
  pageSize: VideoSize | null;
  sizeBytes: number;
  match: SeasonMatch | null;
}

type SeasonGroup = "season" | "several" | "unknown" | "other";

function seasonGroup(match: SeasonMatch | null, season: number): SeasonGroup {
  if (season === anySeason || match === null) return season === anySeason ? "season" : "unknown";
  if (!match.seasons.includes(season)) return "other";
  return match.seasons.length === 1 ? "season" : "several";
}

function matchLabel(match: SeasonMatch | null, scope: ReleaseScope | null, anime: boolean): string {
  const episodes = scope?.episodes ? t("tracker.scope.episodes", scope.episodes) : "";
  if (!match || match.seasons.length === 0) return anime || match ? episodes : scope ? scopeLabel(scope) : "";
  const first = Math.min(...match.seasons);
  const last = Math.max(...match.seasons);
  const seasonText = first === last ? t("common.season", { season: first }) : t("tracker.scope.seasons", { from: first, to: last });
  return [seasonText, episodes].filter(Boolean).join(" · ");
}

function releaseKey(item: RutrackerItem): string {
  return `${item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}|${item.size.replace(/\s+/g, "").toLowerCase()}`;
}

function mergeItems(known: RutrackerItem[], found: RutrackerItem[]): RutrackerItem[] {
  const byId = new Map(known.map((item) => [item.id, item]));
  for (const item of found) {
    const kept = byId.get(item.id);
    if (!kept || item.seeds > kept.seeds) byId.set(item.id, item);
  }
  const byRelease = new Map<string, RutrackerItem>();
  for (const item of byId.values()) {
    const key = releaseKey(item);
    const kept = byRelease.get(key);
    if (!kept || item.seeds > kept.seeds) byRelease.set(key, item);
  }
  return [...byRelease.values()].sort((a, b) => b.seeds - a.seeds);
}

function readable(name: string | undefined): string {
  return name && /^[\p{Script=Latin}\p{Script=Cyrillic}\p{N}\p{P}\p{S}\p{Zs}]+$/u.test(name) ? name : "";
}

function resolutionFilterOf(resolution: string): string | null {
  const rank = qualityRank(resolution);
  return resolutionFilters.find((filter) => rank >= filter.minRank)?.id ?? null;
}

function audioTrackLabel(track: ReleaseAudioTrack): string {
  if (!track.kind) return track.raw;
  const count = track.count !== null ? ` ×${track.count}` : "";
  const detail = track.detail ? ` (${track.detail})` : "";
  return `${t(voiceKindLabels[track.kind])}${count}${detail}`;
}

function scopeLabel(scope: ReleaseScope): string {
  const { seasons, episodes } = scope;
  const seasonText = !seasons
    ? ""
    : seasons[0] === seasons[1]
      ? t("common.season", { season: seasons[0] })
      : t("tracker.scope.seasons", { from: seasons[0], to: seasons[1] });
  return [seasonText, episodes ? t("tracker.scope.episodes", episodes) : ""].filter(Boolean).join(" · ");
}

function searchErrorText(failure: unknown): string {
  if (failure === rutrackerErrors.cancelled) return t("tracker.error.cancelled");
  if (failure === rutrackerErrors.timeout) return t("tracker.error.timeout");
  if (failure === rutrackerErrors.parseFailed) return t("tracker.error.parseFailed");
  if (failure === rutrackerErrors.markupChanged) return t("tracker.error.markupChanged");
  if (typeof failure !== "string") return t("tracker.error.searchFailed");
  if (failure === rutrackerErrors.unexpectedPage || failure.startsWith(`${rutrackerErrors.unexpectedPage}:`)) {
    const page = failure.slice(rutrackerErrors.unexpectedPage.length + 1).trim();
    return page ? t("tracker.error.unexpectedPage", { page }) : t("tracker.error.unexpectedPage.unnamed");
  }
  return failure;
}

function defaultQuery(target: AddSourceTarget): string {
  const { title } = target;
  const original = target.originalTitle ?? "";
  const readable = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{N}\p{P}\p{Zs}]+$/u.test(original);
  const name = readable ? original : title.title;
  return title.type === "movie" ? `${name} ${title.year}`.trim() : name;
}

async function openPage(url: string): Promise<void> {
  if (!isDesktop) {
    window.open(url, "_blank");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

function toggled<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function TrackerSearch({
  target,
  onPick,
}: {
  target: AddSourceTarget;
  onPick: (release: Promise<TorrentPreview>, topicId: string, season?: number, single?: boolean) => void;
}) {
  const initialQuery = useMemo(() => defaultQuery(target), [target]);
  const [queryInput, setQueryInput] = useState(initialQuery);
  const [activeQuery, setActiveQuery] = useState(initialQuery);

  const [items, setItems] = useState<RutrackerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [route, setRoute] = useState<TrackerRoute | null>(null);
  const [serverProblem, setServerProblem] = useState<ServerProblem | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [extraLeft, setExtraLeft] = useState(0);
  const [slow, setSlow] = useState(false);
  const [alternativesQueued, setAlternativesQueued] = useState(false);
  const [othersShown, setOthersShown] = useState(false);

  const prefs = useSettings((state) => state.trackerPrefs);
  const patchSettings = useSettings((state) => state.patch);
  const setPrefs = (change: Partial<typeof prefs>) =>
    patchSettings({ trackerPrefs: { ...useSettings.getState().trackerPrefs, ...change } });
  const seasonNumbers = target.title.type === "tv" ? target.seasons.map((item) => item.seasonNumber).filter((number) => number > 0) : [];
  const [season, setSeason] = useState(() => (seasonNumbers.length > 1 && seasonNumbers.includes(target.defaultSeason) ? target.defaultSeason : anySeason));
  const { t, tn, locale, language } = useT();
  const automatic = activeQuery.trim() === initialQuery.trim();
  const isAnime = target.originalLanguage === "ja";

  const anime = useAsync(
    () =>
      isAnime
        ? animeInfo({ names: [target.originalTitle ?? "", target.title.title], type: target.title.type, year: Number(target.title.year) || null }).catch(() => null)
        : Promise.resolve(null),
    [target.title.type, target.title.id],
  );
  const otherLanguages = useAsync(
    () =>
      target.title.type === "tv"
        ? Promise.all(["ru-RU", "en-US"].map((code) => tmdb.showNames(target.title.id, code).catch(() => null)))
        : Promise.all(
            ["ru-RU", "en-US"].map((code) =>
              tmdb
                .movieTitle(target.title.id, code)
                .then((name): ShowNames => ({ name, seasons: {} }))
                .catch(() => null),
            ),
          ),
    [target.title.type, target.title.id],
  );
  const siteNames = useAsync(
    () =>
      isAnime
        ? animeTrackerNames({
            type: target.title.type,
            id: target.title.id,
            title: target.title.title,
            originalTitle: target.originalTitle ?? "",
            year: target.title.year,
          }).catch(() => [])
        : Promise.resolve([]),
    [target.title.type, target.title.id],
  );
  const namesReady = !anime.loading && !otherLanguages.loading && !siteNames.loading;

  const showNames = useMemo(() => {
    const localized = (otherLanguages.data ?? []).map((names) => names?.name ?? "");
    const animeNames = anime.data ? [anime.data.current.romaji, anime.data.current.english, anime.data.parts[0]?.romaji ?? ""] : [];
    const fromSites = (siteNames.data ?? []).map(readable);
    const names = [initialQuery, ...fromSites.slice(0, 2), ...animeNames, ...fromSites.slice(2), ...localized, target.title.title, readable(target.originalTitle)];
    const cleaned = names.map((name) => name.replace(/\s*\([^()]*\)\s*$/, "").trim()).filter(Boolean);
    return cleaned.filter((name, index) => cleaned.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === index);
  }, [initialQuery, anime.data, otherLanguages.data, siteNames.data, target.title.title, target.originalTitle]);

  const profiles = useMemo<SeasonProfile[]>(() => {
    if (target.title.type !== "tv" || seasonNumbers.length === 0) return [];
    const seasonNames: Record<number, string[]> = {};
    for (const names of otherLanguages.data ?? []) {
      for (const [number, name] of Object.entries(names?.seasons ?? {})) seasonNames[Number(number)] = [...(seasonNames[Number(number)] ?? []), name];
    }
    return buildProfiles({
      seasons: target.seasons,
      showNames,
      seasonNames,
      animeParts: anime.data?.parts ?? null,
      label: (item) => t("common.season", { season: item.seasonNumber }),
      currentYear: new Date().getFullYear(),
    });
  }, [target.title.type, target.seasons, showNames, otherLanguages.data, anime.data, seasonNumbers.length, t]);

  const runner = useRef({ generation: 0, queue: [] as (SearchTask & { generation: number })[], done: new Set<string>(), busy: false, seasonsQueued: -1 });

  const pump = async () => {
    const state = runner.current;
    if (state.busy) return;
    state.busy = true;
    try {
      while (state.queue.length > 0) {
        const task = state.queue.shift()!;
        if (task.generation !== state.generation || state.done.has(taskKey(task))) continue;
        state.done.add(taskKey(task));
        setExtraLeft(state.queue.filter((item) => item.generation === state.generation).length + (task.quiet ? 1 : 0));
        try {
          const found = await rutracker.search(task.query, task.quiet, task.page);
          if (task.generation !== state.generation) continue;
          setItems((known) => mergeItems(known, found));
          const pages = task.season === null ? mainQueryPages : extraQueryPages;
          if (found.length >= rutracker.pageSize && task.page + 1 < pages) {
            state.queue.unshift({ ...task, page: task.page + 1, quiet: true });
          }
          if (!task.quiet) setLoading(false);
        } catch (failure) {
          if (task.generation !== state.generation || task.quiet) continue;
          state.queue = [];
          if (isServerError(failure)) setServerProblem(serverProblemOf(failure));
          else if (failure === rutrackerErrors.authRequired) setNeedsAuth(true);
          else setError(searchErrorText(failure));
          setLoading(false);
        }
      }
    } finally {
      state.busy = false;
      setExtraLeft(0);
    }
  };

  const enqueue = (tasks: SearchTask[]) => {
    const state = runner.current;
    state.queue.push(...tasks.map((task) => ({ ...task, generation: state.generation })));
    void pump();
  };

  const startSearch = () => {
    if (!activeQuery.trim()) return;
    const state = runner.current;
    state.generation += 1;
    state.queue = [];
    state.done = new Set();
    state.seasonsQueued = -1;
    setItems([]);
    setLoading(true);
    setError(null);
    setNeedsAuth(false);
    setServerProblem(null);
    setOthersShown(false);
    setAlternativesQueued(false);
    const generation = state.generation;
    const query = activeQuery.trim();
    void trackerRoute().then((chosen) => {
      if (state.generation !== generation) return;
      setRoute(chosen);
      enqueue([{ query, page: 0, quiet: false, season: null }]);
    });
  };

  useEffect(() => {
    setSlow(false);
    if (!loading || needsAuth) return;
    const timer = setTimeout(() => setSlow(true), slowSearchMs);
    return () => clearTimeout(timer);
  }, [loading, needsAuth]);

  useEffect(() => {
    startSearch();
  }, [activeQuery]);

  useEffect(
    () => () => {
      runner.current.generation += 1;
      runner.current.queue = [];
    },
    [],
  );

  useEffect(() => {
    const state = runner.current;
    if (!automatic || !namesReady || loading || needsAuth || serverProblem !== null || error !== null || state.seasonsQueued === state.generation) return;
    state.seasonsQueued = state.generation;
    const alternatives: SearchTask[] = showNames.slice(1).map((query) => ({ query, page: 0, quiet: true, season: null }));
    const ordered = [...profiles].sort((a, b) => Number(b.number === season) - Number(a.number === season));
    const bySeason = ordered.flatMap((profile) => seasonQueries(showNames, profile)).slice(0, seasonQueryLimit);
    const chosenSeason = bySeason.filter((task) => task.season === season);
    const otherSeasons = bySeason.filter((task) => task.season !== season);
    enqueue(items.length === 0 ? [...alternatives, ...chosenSeason, ...otherSeasons] : [...chosenSeason, ...alternatives, ...otherSeasons]);
    setAlternativesQueued(true);
  }, [automatic, namesReady, loading, needsAuth, serverProblem, error, profiles, showNames]);

  const releases = useMemo(() => new Map(items.map((item) => [item.id, parseTrackerRelease(item.title)])), [items]);
  const [videoSizes, setVideoSizes] = useState<Record<string, VideoSize>>({});
  const [sizeLookupIds, setSizeLookupIds] = useState<ReadonlySet<string>>(new Set());
  const sizeLookups = useRef({ asked: new Set<string>(), pending: new Set<string>(), alive: true });

  useEffect(() => {
    const lookups = sizeLookups.current;
    lookups.alive = true;
    return () => {
      lookups.alive = false;
    };
  }, []);

  useEffect(() => {
    const lookups = sizeLookups.current;
    const wanted = items
      .filter((item) => {
        const release = releases.get(item.id);
        return release !== undefined && isVideoRelease(release) && !release.resolution;
      })
      .slice(0, pageLookupLimit)
      .map((item) => item.id)
      .filter((id) => !lookups.asked.has(id));
    if (wanted.length === 0) return;
    for (const id of wanted) {
      lookups.asked.add(id);
      lookups.pending.add(id);
    }
    setSizeLookupIds(new Set(lookups.pending));
    rutracker
      .videoSizes(wanted)
      .then((found) => {
        if (lookups.alive) setVideoSizes((known) => ({ ...known, ...found }));
      })
      .catch(() => {
        for (const id of wanted) lookups.asked.delete(id);
      })
      .finally(() => {
        for (const id of wanted) lookups.pending.delete(id);
        if (lookups.alive) setSizeLookupIds(new Set(lookups.pending));
      });
  }, [items]);

  const rows = useMemo<ReleaseRow[]>(
    () =>
      items.map((item) => {
        const release = releases.get(item.id) ?? parseTrackerRelease(item.title);
        const pageSize = videoSizes[item.id] ?? null;
        return {
          item,
          release,
          isVideo: isVideoRelease(release),
          resolution: release.resolution || (pageSize ? qualityFromSize(pageSize.width, pageSize.height) : ""),
          pageSize,
          sizeBytes: parseSize(item.size),
          match: matchSeasons(item.title, profiles, isAnime),
        };
      }),
    [items, releases, videoSizes, profiles, isAnime],
  );

  const passesOtherFilters = (row: ReleaseRow) =>
    (!prefs.videoOnly || row.isVideo) && voiceFilters.every((filter) => !prefs.voices.includes(filter.id) || filter.matches(row.release));

  const seasonCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const row of rows) {
      if (!passesOtherFilters(row)) continue;
      for (const number of row.match?.seasons ?? []) counts.set(number, (counts.get(number) ?? 0) + 1);
    }
    return counts;
  }, [rows, prefs.videoOnly, prefs.voices]);

  const beforeResolution = useMemo(
    () => rows.filter((row) => passesOtherFilters(row) && (othersShown || seasonGroup(row.match, season) !== "other")),
    [rows, prefs.videoOnly, prefs.voices, season, othersShown],
  );
  const otherSeasonCount = useMemo(
    () => (season === anySeason ? 0 : rows.filter((row) => passesOtherFilters(row) && seasonGroup(row.match, season) === "other").length),
    [rows, prefs.videoOnly, prefs.voices, season],
  );

  const visible = useMemo(() => {
    const matching =
      prefs.resolutions.length === 0
        ? beforeResolution
        : beforeResolution.filter((row) => prefs.resolutions.includes(resolutionFilterOf(row.resolution) ?? ""));
    if (prefs.sort === "seeds") return matching;
    if (prefs.sort === "best") {
      const { preferredQuality, audioLanguage, subtitleLanguage } = useSettings.getState();
      const wanted: Wanted = {
        resolution: preferredQuality || defaultWantedResolution,
        audio: audioLanguage || (target.originalLanguage ?? ""),
        subtitles: subtitleLanguage && subtitleLanguage !== "off" ? subtitleLanguage : language,
      };
      const scores = new Map(matching.map((row) => [row.item.id, releaseScore(row, wanted, target.originalLanguage ?? "")]));
      return [...matching].sort((a, b) => (scores.get(b.item.id) ?? 0) - (scores.get(a.item.id) ?? 0));
    }
    const direction = prefs.sort === "sizeDesc" ? -1 : 1;
    return [...matching].sort((a, b) => direction * (a.sizeBytes - b.sizeBytes));
  }, [beforeResolution, prefs.resolutions, prefs.sort, language, target.originalLanguage]);

  const groupOrder: SeasonGroup[] = ["season", "several", "unknown", "other"];
  const grouped = useMemo(
    () =>
      season === anySeason
        ? visible
        : groupOrder.flatMap((group) => visible.filter((row) => seasonGroup(row.match, season) === group)),
    [visible, season],
  );

  const filtersActive = prefs.resolutions.length > 0 || prefs.voices.length > 0 || season !== anySeason;
  const resetFilters = () => {
    setPrefs({ resolutions: [], voices: [] });
    setSeason(anySeason);
  };
  const chooseSeason = (number: number) => {
    setSeason(number);
    setOthersShown(false);
  };

  const handleLogin = async () => {
    setAuthBusy(true);
    try {
      await rutracker.login();
      startSearch();
    } catch (failure) {
      if (failure !== rutrackerErrors.cancelled) useUi.getState().toast(t("tracker.error.loginFailed"), "error");
    } finally {
      setAuthBusy(false);
    }
  };

  const pickItem = (row: ReleaseRow) => {
    setResolvingId(row.item.id);
    const release = rutracker.inspectRelease(row.item.id);
    release.catch(() => undefined).finally(() => setResolvingId(null));
    const seasons = row.match?.seasons ?? [];
    const picked = season !== anySeason && seasons.includes(season) ? season : seasons.length > 0 ? Math.min(...seasons) : undefined;
    onPick(release, row.item.id, picked, seasons.length === 1);
  };

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    if (queryInput === activeQuery) startSearch();
    else setActiveQuery(queryInput);
  };

  return (
    <div className="archive">
      <div className="archive__head">
        <Search size={16} />
        <strong>{t("tracker.title")}</strong>
        <span>RuTracker.org</span>
      </div>

      {route === "server" && !needsAuth && serverProblem === null && (
        <div className="tracker-route">
          <Server size={15} className="tracker-route__icon" />
          <span className="tracker-route__text">{t("tracker.server.via")}</span>
          <button
            type="button"
            className="button button--small tracker-route__login"
            title={t("tracker.server.loginHint")}
            disabled={authBusy}
            onClick={() => void handleLogin()}
          >
            {authBusy ? <LoaderCircle size={14} className="spin" /> : <LogIn size={14} />}
            {t("tracker.server.login")}
          </button>
        </div>
      )}

      {serverProblem !== null ? (
        <div className="tracker-auth">
          <p className="archive__note">{t(`tracker.server.problem.${serverProblem}`)}</p>
          <div className="tracker-auth__actions">
            <button type="button" className="button button--primary" disabled={authBusy} onClick={() => void handleLogin()}>
              {authBusy ? <LoaderCircle size={16} className="spin" /> : <LogIn size={16} />}
              {t("tracker.server.login")}
            </button>
            <button type="button" className="button" disabled={authBusy} onClick={startSearch}>
              {t("tracker.server.retry")}
            </button>
          </div>
        </div>
      ) : needsAuth ? (
        <div className="tracker-auth">
          <p className="archive__note">{t("tracker.auth.note")}</p>
          <button type="button" className="button button--primary" disabled={authBusy} onClick={() => void handleLogin()}>
            {authBusy ? <LoaderCircle size={16} className="spin" /> : t("tracker.auth.login")}
          </button>
        </div>
      ) : (
        <>
          <form className="tracker-form" onSubmit={submitSearch}>
            <input
              className="input"
              data-autofocus
              aria-label={t("tracker.query.placeholder")}
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              placeholder={t("tracker.query.placeholder")}
            />
            <button className="button button--primary" type="submit" disabled={loading}>
              {t("tracker.search")}
            </button>
          </form>
          {seasonNumbers.length > 1 && (
            <div className="tracker-seasons" role="group" aria-label={t("tracker.filter.season")}>
              <button
                type="button"
                className={`chip ${season === anySeason ? "is-active" : ""}`}
                aria-pressed={season === anySeason}
                onClick={() => chooseSeason(anySeason)}
              >
                {t("tracker.filter.allSeasons")}
                <small>{rows.filter(passesOtherFilters).length}</small>
              </button>
              {profiles.map((profile) => {
                const active = season === profile.number;
                const name = target.seasons.find((item) => item.seasonNumber === profile.number)?.name ?? "";
                const named = profile.names.length > 0 && name.length <= seasonChipNameLength && !/\d/.test(name);
                return (
                  <button
                    key={profile.number}
                    type="button"
                    className={`chip ${active ? "is-active" : ""}`}
                    aria-pressed={active}
                    title={name || profile.label}
                    onClick={() => chooseSeason(profile.number)}
                  >
                    {named ? (
                      <>
                        <b>{profile.number}</b>
                        {name}
                      </>
                    ) : (
                      profile.label
                    )}
                    <small>{seasonCounts.get(profile.number) ?? 0}</small>
                  </button>
                );
              })}
            </div>
          )}
          {extraLeft > 0 && !loading && (
            <p className="tracker-more">
              <LoaderCircle size={13} className="spin" />
              {t("tracker.searchingMore")}
            </p>
          )}

          <div className="tracker-filters">
            <div className="tracker-filters__group" role="group" aria-label={t("tracker.filter.resolution")}>
              {resolutionFilters.map((filter) => {
                const count = beforeResolution.filter((row) => resolutionFilterOf(row.resolution) === filter.id).length;
                const active = prefs.resolutions.includes(filter.id);
                return (
                  <button
                    key={filter.id}
                    type="button"
                    className={`chip ${active ? "is-active" : ""}`}
                    aria-pressed={active}
                    onClick={() => setPrefs({ resolutions: toggled(prefs.resolutions, filter.id) })}
                  >
                    {filter.label}
                    <small>{count}</small>
                  </button>
                );
              })}
            </div>
            <div className="tracker-filters__group" role="group" aria-label={t("tracker.filter.sound")}>
              {voiceFilters.map((filter) => {
                const active = prefs.voices.includes(filter.id);
                return (
                  <button
                    key={filter.id}
                    type="button"
                    className={`chip ${active ? "is-active" : ""}`}
                    aria-pressed={active}
                    onClick={() => setPrefs({ voices: toggled(prefs.voices, filter.id) })}
                  >
                    {t(filter.label)}
                  </button>
                );
              })}
              <button
                type="button"
                className={`chip ${prefs.videoOnly ? "is-active" : ""}`}
                aria-pressed={prefs.videoOnly}
                title={t("tracker.filter.videoOnly.note")}
                onClick={() => setPrefs({ videoOnly: !prefs.videoOnly })}
              >
                {t("tracker.filter.videoOnly")}
              </button>
            </div>
            <div className="tracker-filters__group tracker-filters__group--end">
              <select
                className="select"
                aria-label={t("tracker.sort")}
                value={prefs.sort}
                onChange={(event) => setPrefs({ sort: event.target.value as TrackerSort })}
              >
                {sortOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {t(option.label)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {loading ? (
            <>
              <p className="archive__note">{t("tracker.searching", { query: activeQuery })}</p>
              {slow && route === "own" && (
                <div className="tracker-slow">
                  <p className="archive__note">{t("tracker.slow.note")}</p>
                  <button type="button" className="button" onClick={() => void rutracker.showWindow()}>
                    {t("tracker.slow.show")}
                  </button>
                </div>
              )}
            </>
          ) : error ? (
            <p className="archive__note">{error}</p>
          ) : items.length === 0 && (extraLeft > 0 || (automatic && !alternativesQueued)) ? (
            <p className="archive__note">{t("tracker.searchingMore")}</p>
          ) : items.length === 0 ? (
            <p className="archive__note">{t("tracker.empty", { query: activeQuery })}</p>
          ) : visible.length === 0 && otherSeasonCount === 0 ? (
            <p className="archive__note">
              {tn("tracker.noneMatch", items.length)}{" "}
              {filtersActive ? (
                <button type="button" className="link-button" onClick={resetFilters}>
                  {t("tracker.resetFilters")}
                </button>
              ) : (
                <button type="button" className="link-button" onClick={() => setPrefs({ videoOnly: false })}>
                  {t("tracker.showNonVideo")}
                </button>
              )}
            </p>
          ) : (
            <div className="tracker-list">
              {grouped.map((row, index) => {
                const group = seasonGroup(row.match, season);
                const startsGroup = season !== anySeason && group !== "season" && (index === 0 || seasonGroup(grouped[index - 1].match, season) !== group);
                return (
                  <div key={row.item.id} className="tracker-list__entry">
                    {startsGroup && <h3 className="tracker-list__group">{t(`tracker.group.${group}`, { season })}</h3>}
                    <TrackerItem
                      row={row}
                      best={prefs.sort === "best" && index === 0 && row.isVideo && group === "season"}
                      anime={isAnime}
                      originalLanguage={target.originalLanguage ?? ""}
                      locale={locale}
                      pageSizeLoading={sizeLookupIds.has(row.item.id)}
                      resolving={resolvingId === row.item.id}
                      disabled={resolvingId !== null}
                      onPick={() => pickItem(row)}
                    />
                  </div>
                );
              })}
              {otherSeasonCount > 0 && !othersShown && (
                <button type="button" className="tracker-others" onClick={() => setOthersShown(true)}>
                  <ChevronDown size={15} />
                  {tn("tracker.otherSeasons", otherSeasonCount)}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TrackerResolution({ row, loading }: { row: ReleaseRow; loading: boolean }) {
  const { t } = useT();
  if (row.release.resolution) {
    return (
      <span className="tracker-item__stat tracker-item__stat--resolution" title={t("tracker.resolution.fromTitle")}>
        <Monitor size={13} />
        {row.release.resolution}
      </span>
    );
  }
  if (row.pageSize) {
    return (
      <span className="tracker-item__stat tracker-item__stat--resolution" title={t("tracker.resolution.fromPage")}>
        <Monitor size={13} />
        {row.resolution}
        <small>
          {row.pageSize.width}×{row.pageSize.height}
        </small>
      </span>
    );
  }
  return (
    <span
      className="tracker-item__stat tracker-item__stat--resolution is-unknown"
      title={loading ? t("tracker.resolution.loading") : t("tracker.resolution.unknown")}
    >
      <Monitor size={13} />
      {loading ? <LoaderCircle size={12} className="spin" /> : "—"}
    </span>
  );
}

function TrackerItem({
  row,
  best,
  anime,
  originalLanguage,
  locale,
  pageSizeLoading,
  resolving,
  disabled,
  onPick,
}: {
  row: ReleaseRow;
  best: boolean;
  anime: boolean;
  originalLanguage: string;
  locale: string;
  pageSizeLoading: boolean;
  resolving: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const { t } = useT();
  const { item, release, isVideo } = row;
  const audioLanguages = release.audioLanguages.map((code) => (code === originalLanguageMark ? originalLanguage : code));

  return (
    <div className={`tracker-item ${best ? "is-best" : ""}`}>
      <div className="tracker-item__body">
        <div className="tracker-item__meta">
          {best && (
            <span className="tracker-item__best" title={t("tracker.best.note")}>
              <Sparkles size={12} />
              {t("tracker.best")}
            </span>
          )}
          {release.quality && <span className="quality-tag">{release.quality}</span>}
          {(() => {
            const label = matchLabel(row.match, release.scope, anime);
            return label ? <span className="tracker-item__tag tracker-item__tag--scope">{label}</span> : null;
          })()}
          {release.tags.map((tag) => (
            <span key={tag} className="tracker-item__tag">
              {tag}
            </span>
          ))}
          <div className="tracker-item__stats">
            {isVideo && <TrackerResolution row={row} loading={pageSizeLoading} />}
            <span className="tracker-item__stat tracker-item__stat--size" title={t("tracker.size")}>
              <HardDrive size={13} />
              {item.size}
            </span>
            <span className="tracker-item__stat tracker-item__stat--seeds" title={t("tracker.seeds")}>
              <ArrowUp size={13} />
              {item.seeds}
            </span>
          </div>
        </div>
        <strong className={`tracker-item__name ${isVideo ? "" : "tracker-item__name--full"}`} title={item.title}>
          {isVideo ? release.name : item.title}
        </strong>
        {isVideo && (
          <dl className="tracker-item__tracks">
            <dt>{t("tracker.voiceover")}</dt>
            <dd>
              <LanguageFlags available={audioLanguages} locale={locale} />
              <span>{release.audio.length > 0 ? release.audio.map(audioTrackLabel).join(" · ") : t("tracker.voiceover.notListed")}</span>
            </dd>
            <dt>{t("common.subtitles")}</dt>
            <dd>
              <LanguageFlags available={release.subtitleLanguages} locale={locale} />
            </dd>
          </dl>
        )}
      </div>
      <button className="icon-button" aria-label={t("tracker.page")} title={t("tracker.page")} onClick={() => void openPage(item.pageUrl)}>
        <ExternalLink size={15} />
      </button>
      <button className={`button button--small ${best ? "button--primary" : ""}`} disabled={disabled} onClick={onPick}>
        {resolving ? <LoaderCircle size={15} className="spin" /> : t("tracker.pick")}
      </button>
    </div>
  );
}
