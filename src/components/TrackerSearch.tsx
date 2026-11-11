import { useEffect, useMemo, useState } from "react";
import { ArrowUp, ExternalLink, HardDrive, LoaderCircle, Monitor, Search, Sparkles } from "lucide-react";
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
import { rutracker, rutrackerErrors, type RutrackerItem, type VideoSize } from "../lib/rutracker";
import { useAsync } from "../lib/useAsync";
import { useSettings, type TrackerSort } from "../state/settings";
import { useUi, type AddSourceTarget } from "../state/ui";
import { LanguageFlags } from "./LanguageFlags";

const pageLookupLimit = 20;
const anySeason = 0;

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
  seasons: [number, number] | null;
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

export function TrackerSearch({ target, onPick }: { target: AddSourceTarget; onPick: (release: Promise<TorrentPreview>, topicId: string) => void }) {
  const initialQuery = useMemo(() => defaultQuery(target), [target]);
  const [queryInput, setQueryInput] = useState(initialQuery);
  const [activeQuery, setActiveQuery] = useState(initialQuery);

  const [items, setItems] = useState<RutrackerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const prefs = useSettings((state) => state.trackerPrefs);
  const patchSettings = useSettings((state) => state.patch);
  const setPrefs = (change: Partial<typeof prefs>) =>
    patchSettings({ trackerPrefs: { ...useSettings.getState().trackerPrefs, ...change } });
  const [season, setSeason] = useState(anySeason);
  const { t, tn, locale, language } = useT();

  const fetchResults = async () => {
    if (!activeQuery) return;
    setLoading(true);
    setError(null);
    setNeedsAuth(false);
    try {
      setItems(await rutracker.search(activeQuery));
    } catch (failure) {
      if (failure === rutrackerErrors.authRequired) setNeedsAuth(true);
      else setError(searchErrorText(failure));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchResults();
  }, [activeQuery]);

  const releases = useMemo(() => new Map(items.map((item) => [item.id, parseTrackerRelease(item.title)])), [items]);
  const [videoSizes, setVideoSizes] = useState<Record<string, VideoSize>>({});
  const [sizeLookupIds, setSizeLookupIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const unresolved = items
      .filter((item) => {
        const release = releases.get(item.id);
        return release !== undefined && isVideoRelease(release) && !release.resolution;
      })
      .slice(0, pageLookupLimit)
      .map((item) => item.id);
    setVideoSizes({});
    setSizeLookupIds(new Set(unresolved));
    if (unresolved.length === 0) return;

    let stale = false;
    rutracker
      .videoSizes(unresolved)
      .then((found) => {
        if (!stale) setVideoSizes(found);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stale) setSizeLookupIds(new Set());
      });
    return () => {
      stale = true;
    };
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
          seasons: release.scope?.seasons ?? null,
        };
      }),
    [items, releases, videoSizes],
  );

  const beforeResolution = useMemo(
    () =>
      rows.filter(
        (row) =>
          (!prefs.videoOnly || row.isVideo) &&
          voiceFilters.every((filter) => !prefs.voices.includes(filter.id) || filter.matches(row.release)) &&
          (season === anySeason || row.seasons === null || (row.seasons[0] <= season && season <= row.seasons[1])),
      ),
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

  const filtersActive = prefs.resolutions.length > 0 || prefs.voices.length > 0 || season !== anySeason;
  const resetFilters = () => {
    setPrefs({ resolutions: [], voices: [] });
    setSeason(anySeason);
  };

  const handleLogin = async () => {
    setAuthBusy(true);
    try {
      await rutracker.login();
      await fetchResults();
    } catch (failure) {
      if (failure !== rutrackerErrors.cancelled) useUi.getState().toast(t("tracker.error.loginFailed"), "error");
    } finally {
      setAuthBusy(false);
    }
  };

  const pickItem = (item: RutrackerItem) => {
    setResolvingId(item.id);
    const release = rutracker.inspectRelease(item.id);
    release.catch(() => undefined).finally(() => setResolvingId(null));
    onPick(release, item.id);
  };

  const anime = useAsync(
    () =>
      target.originalLanguage === "ja"
        ? animeInfo({ names: [target.originalTitle ?? "", target.title.title], type: target.title.type, year: Number(target.title.year) || null })
        : Promise.resolve(null),
    [target.title.type, target.title.id],
  );
  const otherNames = anime.data
    ? [...new Set([anime.data.current.romaji, anime.data.current.english])].filter(
        (name) => name && name.toLowerCase() !== activeQuery.trim().toLowerCase(),
      )
    : [];
  const searchFor = (name: string) => {
    setQueryInput(name);
    setActiveQuery(name);
  };

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    if (queryInput === activeQuery) void fetchResults();
    else setActiveQuery(queryInput);
  };

  const seasonNumbers = target.title.type === "tv" ? target.seasons.map((item) => item.seasonNumber).filter((number) => number > 0) : [];

  return (
    <div className="archive">
      <div className="archive__head">
        <Search size={16} />
        <strong>{t("tracker.title")}</strong>
        <span>RuTracker.org</span>
      </div>

      {needsAuth ? (
        <div className="tracker-auth">
          <p className="archive__note">{t("tracker.auth.note")}</p>
          <button type="button" className="button button--primary" disabled={authBusy} onClick={() => void handleLogin()}>
            {authBusy ? <LoaderCircle size={16} className="spin" /> : t("tracker.auth.login")}
          </button>
        </div>
      ) : (
        <>
          <form className="tracker-form" onSubmit={submitSearch}>
            <input className="input" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder={t("tracker.query.placeholder")} />
            <button className="button button--primary" type="submit" disabled={loading}>
              {t("tracker.search")}
            </button>
          </form>
          {otherNames.length > 0 && (
            <div className="tracker-names">
              <span>{t("tracker.names.hint")}</span>
              {otherNames.map((name) => (
                <button key={name} type="button" className="chip" disabled={loading} onClick={() => searchFor(name)}>
                  {name}
                </button>
              ))}
            </div>
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
              {seasonNumbers.length > 1 && (
                <select className="select" aria-label={t("tracker.filter.season")} value={season} onChange={(event) => setSeason(Number(event.target.value))}>
                  <option value={anySeason}>{t("tracker.filter.allSeasons")}</option>
                  {seasonNumbers.map((number) => (
                    <option key={number} value={number}>
                      {t("common.season", { season: number })}
                    </option>
                  ))}
                </select>
              )}
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
            <p className="archive__note">{t("tracker.searching", { query: activeQuery })}</p>
          ) : error ? (
            <p className="archive__note">{error}</p>
          ) : items.length === 0 ? (
            <p className="archive__note">{t("tracker.empty", { query: activeQuery })}</p>
          ) : visible.length === 0 ? (
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
              {visible.map((row, index) => (
                <TrackerItem
                  key={row.item.id}
                  row={row}
                  best={prefs.sort === "best" && index === 0 && row.isVideo}
                  originalLanguage={target.originalLanguage ?? ""}
                  locale={locale}
                  pageSizeLoading={sizeLookupIds.has(row.item.id)}
                  resolving={resolvingId === row.item.id}
                  disabled={resolvingId !== null}
                  onPick={() => pickItem(row.item)}
                />
              ))}
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
  originalLanguage,
  locale,
  pageSizeLoading,
  resolving,
  disabled,
  onPick,
}: {
  row: ReleaseRow;
  best: boolean;
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
          {release.scope && <span className="tracker-item__tag tracker-item__tag--scope">{scopeLabel(release.scope)}</span>}
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
