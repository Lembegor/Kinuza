import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  Check,
  CheckCheck,
  CircleCheck,
  Clapperboard,
  Cloud,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  ListChecks,
  Play,
  Plus,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { CatalogError, PosterRow, typeLabel } from "../components/Cards";
import { AnimeOrder } from "../components/AnimeOrder";
import { FranchiseRow } from "../components/Franchise";
import { Gallery } from "../components/Gallery";
import { RatingStars, StatusMenu } from "../components/TrackControls";
import { TrailerOverlay } from "../components/TrailerOverlay";
import { backend, describeError, isDesktop } from "../lib/backend";
import { formatBytes, formatDate, formatRuntime, formatSpeed } from "../lib/format";
import { t, useT } from "../lib/i18n";
import { arcOf, episodeLayout, inLayout, type Arc, type EpisodeLayout } from "../lib/episodeLayout";
import { localizedTexts, needsLocalizing } from "../lib/localized";
import { imageUrl, tmdb, type Details, type Episode, type MediaType } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { checkAvailability, checkedOf, useAvailability } from "../state/availability";
import { localDay } from "../state/calendar";
import { isWatched, toTitleRef, unitKey, useLibrary, type Source, type TitleRef } from "../state/library";
import { useSettings } from "../state/settings";
import { fileOf, fileProgress, useTorrents } from "../state/torrents";
import { useUi, type AddSourceTarget } from "../state/ui";
import { recordActivity, titleOf } from "../state/activity";
import { sortSources } from "../lib/sources";
import { useHoverWarm, warmTitleResume } from "../state/warmup";

const specialsSeason = 0;
const namedDirectorCount = 4;

export { sortSources };

async function revealFile(source: Source): Promise<void> {
  try {
    const path = await backend.fileLocation(source.infoHash, source.fileIndex);
    if (!isDesktop) return;
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch (error) {
    useUi.getState().toast(describeError(error), "error");
  }
}

async function downloadSource(source: Source): Promise<void> {
  try {
    await backend.selectFiles(source.infoHash, [source.fileIndex], useSettings.getState().downloadDir || null);
    await useTorrents.getState().refresh();
    useUi.getState().toast(t("title.downloadStarted"), "success");
  } catch (error) {
    useUi.getState().toast(describeError(error), "error");
  }
}

function removeSourceWithUndo(key: string, source: Source): void {
  const { removeSource, addSources } = useLibrary.getState();
  removeSource(key, source.id);
  useUi.getState().toast(t("title.source.removed", { quality: source.quality || t("common.video") }), "info", {
    label: t("feed.dismissed.undo"),
    run: () => addSources([{ unitKey: key, source }]),
  });
}

function SourceStatus({ source }: { source: Source }) {
  const torrent = useTorrents((state) => state.byHash[source.infoHash]);
  const { t } = useT();
  if (!torrent) return <span className="source-status source-status--missing">{t("title.source.missing")}</span>;

  const progress = fileProgress(torrent, source.fileIndex);
  if (progress >= 1) {
    return (
      <span className="source-status source-status--done">
        <CircleCheck size={14} />
        {t("common.downloaded")}
      </span>
    );
  }
  if (fileOf(torrent, source.fileIndex)?.included === false) {
    return (
      <span className="source-status source-status--online" title={t("title.source.online.note")}>
        <Cloud size={14} />
        {t("title.source.online")}
        <button className="button button--small" onClick={() => void downloadSource(source)}>
          <Download size={13} />
          {t("common.download")}
        </button>
      </span>
    );
  }
  const speed = torrent.state === "live" && torrent.downloadSpeed > 0 ? ` · ${formatSpeed(torrent.downloadSpeed)}` : "";
  const label = torrent.state === "paused" ? t("title.source.paused") : `${Math.floor(progress * 100)}%${speed}`;
  return (
    <span className="source-status">
      <span className="bar bar--inline">
        <i style={{ width: `${progress * 100}%` }} />
      </span>
      {label}
    </span>
  );
}

function QualityChip({ source, onRemove }: { source: Source; onRemove: () => void }) {
  const progress = useTorrents((state) => fileProgress(state.byHash[source.infoHash], source.fileIndex));
  const onlineOnly = useTorrents((state) => fileOf(state.byHash[source.infoHash], source.fileIndex)?.included === false);
  const { t } = useT();
  return (
    <span className={`quality-chip ${progress >= 1 ? "is-ready" : ""}`} title={source.fileName}>
      {source.quality || t("common.video")}
      {progress < 1 && !onlineOnly && <small>{Math.floor(progress * 100)}%</small>}
      {progress < 1 && onlineOnly && (
        <>
          <small>{t("title.source.online")}</small>
          <button aria-label={t("title.episode.download")} title={t("title.source.saveToDisk")} onClick={() => void downloadSource(source)}>
            <Download size={11} />
          </button>
        </>
      )}
      <button className="quality-chip__remove" aria-label={t("title.source.remove")} title={t("title.source.remove")} onClick={onRemove}>
        <X size={13} />
      </button>
    </span>
  );
}

function MovieSources({ title, target }: { title: TitleRef; target: AddSourceTarget }) {
  const key = unitKey("movie", title.id);
  const stored = useLibrary((state) => state.sources[key]);
  const sources = useMemo(() => sortSources(stored ?? []), [stored]);
  const { play, openAddSource } = useUi.getState();
  const { t } = useT();

  return (
    <section className="section">
      <div className="section__head">
        <h2>{t("title.sources")}</h2>
        <button className="button" onClick={() => openAddSource({ target })}>
          <Plus size={16} />
          {t("common.addTorrent")}
        </button>
      </div>
      {sources.length === 0 ? (
        <div className="hint-card">
          <Clapperboard size={22} />
          <div>
            <strong>{t("title.sources.empty.title")}</strong>
            <p>{t("title.sources.empty.text")}</p>
          </div>
        </div>
      ) : (
        <div className="source-list">
          {sources.map((source) => (
            <div key={source.id} className="source-row">
              <button className="round-button" aria-label={t("title.watch")} onClick={() => play({ title, unitKey: key, preferredSourceId: source.id })}>
                <Play size={16} fill="currentColor" />
              </button>
              <div className="source-row__main">
                <div className="source-row__title">
                  <span className="quality-tag">{source.quality || t("common.video")}</span>
                  {source.tags.map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                  <span className="source-row__size">{formatBytes(source.size)}</span>
                </div>
                <div className="source-row__file">{source.fileName}</div>
              </div>
              <SourceStatus source={source} />
              <button className="icon-button" aria-label={t("title.source.reveal")} onClick={() => void revealFile(source)}>
                <FolderOpen size={16} />
              </button>
              <button className="icon-button" aria-label={t("title.source.remove")} title={t("title.source.remove")} onClick={() => removeSourceWithUndo(key, source)}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Overview({ text }: { text: string }) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const element = textRef.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <>
      <p ref={textRef} className={`title-hero__overview ${expanded ? "is-expanded" : ""}`}>
        {text}
      </p>
      {(overflows || expanded) && (
        <button className="text-button title-hero__more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? t("person.bio.less") : t("person.bio.more")}
        </button>
      )}
    </>
  );
}

function EpisodeRow({
  title,
  episode,
  target,
  onMarkUpTo,
}: {
  title: TitleRef;
  episode: Episode;
  target: AddSourceTarget;
  onMarkUpTo: (() => void) | null;
}) {
  const key = unitKey("tv", title.id, episode.season, episode.episode);
  const stored = useLibrary((state) => state.sources[key]);
  const progress = useLibrary((state) => state.progress[key]);
  const { setWatched } = useLibrary.getState();
  const play = useUi((state) => state.play);
  const openAddSource = useUi((state) => state.openAddSource);
  const spoilerDescriptions = useSettings((state) => state.spoilerDescriptions);
  const spoilerStills = useSettings((state) => state.spoilerStills);
  const [revealed, setRevealed] = useState(false);
  const { t } = useT();

  const sources = useMemo(() => sortSources(stored ?? []), [stored]);
  const watched = isWatched(progress);
  const guarded = !watched && !revealed && spoilerDescriptions !== "show";
  const stillGuarded = !watched && !revealed && spoilerStills;
  const playable = sources.length > 0;
  const aired = episode.airDate !== "" && episode.airDate <= localDay(new Date());
  const findSource = () => openAddSource({ target: { ...target, defaultSeason: episode.season, defaultEpisode: episode.episode } });
  const still = imageUrl(episode.still, "w300");
  const hoverWarm = useHoverWarm(playable ? key : null);
  const watchedShare = progress && progress.duration > 0 ? Math.min(1, progress.position / progress.duration) : 0;

  const start = (preferredSourceId?: string) =>
    play({
      title,
      unitKey: key,
      season: episode.season,
      episode: episode.episode,
      episodeName: episode.name,
      preferredSourceId,
    });

  return (
    <div data-episode={episode.episode} className={`episode ${playable ? "is-playable" : ""} ${watched ? "is-watched" : ""} ${!playable && !aired ? "is-upcoming" : ""}`}>
      <div className="episode__media">
        <button
          className="episode__still"
          {...hoverWarm}
          disabled={!playable && !aired}
          onClick={() => (playable ? start() : findSource())}
          aria-label={playable ? t("title.episode.watch") : t("title.episode.find")}
        >
          {still ? (
            <img src={still} alt="" loading="lazy" draggable={false} className={stillGuarded ? "is-spoiler" : ""} />
          ) : (
            <div className="episode__blank" />
          )}
          {playable && (
            <span className="episode__play">
              <Play size={20} fill="currentColor" />
            </span>
          )}
          {!playable && aired && (
            <span className="episode__find">
              <Search size={15} />
              {t("title.episode.find")}
            </span>
          )}
          {!playable && !aired && (
            <span className="episode__airs">{episode.airDate ? t("title.episode.airs", { date: formatDate(episode.airDate) }) : t("title.episode.airsUnknown")}</span>
          )}
          {watchedShare > 0 && !watched && (
            <div className="bar bar--thin">
              <i style={{ width: `${watchedShare * 100}%` }} />
            </div>
          )}
          {watched && (
            <span className="episode__seen">
              <Check size={13} />
            </span>
          )}
        </button>
        {still && stillGuarded && (
          <button className="episode__unveil" onClick={() => setRevealed(true)}>
            <Eye size={13} />
            <span>{t("title.episode.showStill")}</span>
          </button>
        )}
      </div>
      <div className="episode__body">
        <div className="episode__title">
          <span className="episode__number">{episode.episode}</span>
          {episode.name}
        </div>
        <div className="episode__meta">
          {[formatDate(episode.airDate), formatRuntime(episode.runtimeMinutes)].filter(Boolean).join(" · ")}
        </div>
        {episode.overview &&
          (guarded && spoilerDescriptions === "hide" ? (
            <button className="episode__reveal" onClick={() => setRevealed(true)}>
              <Eye size={13} />
              {t("title.episode.showDescription")}
            </button>
          ) : (
            <p
              className={`episode__overview ${guarded ? "is-veiled" : ""}`}
              role={guarded ? "button" : undefined}
              tabIndex={guarded ? 0 : undefined}
              aria-label={guarded ? t("title.episode.spoiler") : undefined}
              data-hint={guarded ? t("title.episode.spoilerHint") : undefined}
              onClick={guarded ? () => setRevealed(true) : undefined}
              onKeyDown={
                guarded
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setRevealed(true);
                      }
                    }
                  : undefined
              }
            >
              {episode.overview}
            </p>
          ))}
      </div>
      <div className="episode__side">
        <div className="episode__chips">
          {sources.map((source) => (
            <QualityChip key={source.id} source={source} onRemove={() => removeSourceWithUndo(key, source)} />
          ))}
        </div>
        {onMarkUpTo && !watched && (
          <button className="icon-button" aria-label={t("title.episode.markUpTo")} title={t("title.episode.markUpTo")} onClick={onMarkUpTo}>
            <ListChecks size={16} />
          </button>
        )}
        <button
          className="icon-button"
          aria-label={watched ? t("title.episode.markUnwatched") : t("title.episode.markWatched")}
          title={watched ? t("title.episode.markUnwatched") : t("title.episode.markWatched")}
          onClick={() =>
            setWatched(key, !watched, { title, season: episode.season, episode: episode.episode, episodeName: episode.name })
          }
        >
          {watched ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
    </div>
  );
}

function arcLabel(arc: Arc, details: Details): string {
  const name = arc.chunk ? "" : (details.seasons.find((item) => item.seasonNumber === arc.season)?.name ?? arc.name);
  return name ? `${name} · ${arc.first}-${arc.last}` : `${arc.first}-${arc.last}`;
}

function SeriesEpisodes({
  details,
  title,
  season,
  layout,
  focusEpisode,
  onSeasonChange,
  target,
}: {
  details: Details;
  title: TitleRef;
  season: number;
  layout: EpisodeLayout | null;
  focusEpisode: number | null;
  onSeasonChange: (season: number, episode?: number) => void;
  target: AddSourceTarget;
}) {
  const seasonEpisodes = useAsync(() => tmdb.season(details.id, season), [details.id, season]);
  const sectionRef = useRef<HTMLElement>(null);
  const [jump, setJump] = useState("");
  const long = layout !== null && inLayout(layout, season);
  const seasonArcs = long ? layout!.arcs.filter((arc) => arc.season === season) : [];
  const [chunkFirst, setChunkFirst] = useState<number | null>(null);
  const currentArc =
    seasonArcs.length > 1
      ? (seasonArcs.find((arc) => arc.first === chunkFirst) ??
        (focusEpisode !== null ? seasonArcs.find((arc) => focusEpisode >= arc.first && focusEpisode <= arc.last) : undefined) ??
        seasonArcs[0])
      : null;
  const episodes = useMemo(
    () => ({
      ...seasonEpisodes,
      data:
        seasonEpisodes.data && currentArc
          ? seasonEpisodes.data.filter((episode) => episode.episode >= currentArc.first && episode.episode <= currentArc.last)
          : seasonEpisodes.data,
    }),
    [seasonEpisodes, currentArc],
  );

  useEffect(() => {
    const bar = sectionRef.current?.querySelector<HTMLElement>(".arc-bar__chips");
    const chip = bar?.querySelector<HTMLElement>(".chip.is-active");
    if (bar && chip) bar.scrollTo({ left: chip.offsetLeft - bar.clientWidth / 2 + chip.clientWidth / 2, behavior: "smooth" });
  }, [season, currentArc?.first, layout]);

  useEffect(() => {
    if (focusEpisode === null || !episodes.data?.some((episode) => episode.episode === focusEpisode)) return;
    const row = sectionRef.current?.querySelector(`[data-episode="${focusEpisode}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusEpisode, episodes.data]);

  const goTo = (event: React.FormEvent) => {
    event.preventDefault();
    if (!layout) return;
    const number = Number.parseInt(jump, 10);
    const arc = Number.isFinite(number) ? arcOf(layout, number) : null;
    if (!arc) return;
    setChunkFirst(arc.chunk ? arc.first : null);
    onSeasonChange(arc.season, number);
    setJump("");
  };
  const sources = useLibrary((state) => state.sources);
  const progress = useLibrary((state) => state.progress);
  const openAddSource = useUi((state) => state.openAddSource);
  const { t, tn } = useT();

  const keyOf = (episode: Episode) => unitKey("tv", details.id, episode.season, episode.episode);
  const list = episodes.data ?? [];
  const total = list.length;
  const available = list.filter((episode) => sources[keyOf(episode)]).length;
  const watched = list.filter((episode) => isWatched(progress[keyOf(episode)])).length;
  const seasonWatched = total > 0 && watched === total;

  const note = [
    tn("common.episodes", total),
    available > 0 ? t("title.episodes.added", { count: available }) : "",
    watched > 0 ? t("title.episodes.watched", { count: watched }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const markUpTo = async (until: Episode) => {
    const today = localDay(new Date());
    const earlierSeasons = details.seasons.filter((item) => item.seasonNumber !== specialsSeason && item.seasonNumber < until.season);
    const earlier = await Promise.all(earlierSeasons.map((item) => tmdb.season(details.id, item.seasonNumber).catch(() => [] as Episode[])));
    const chosen = [...earlier.flat(), ...list.filter((episode) => episode.episode <= until.episode)].filter(
      (episode) => episode.airDate !== "" && episode.airDate <= today,
    );
    const known = useLibrary.getState().progress;
    const fresh = chosen.filter((episode) => !isWatched(known[keyOf(episode)]));
    if (fresh.length === 0) return;
    const entries = fresh.map((episode) => ({
      unitKey: keyOf(episode),
      context: { title, season: episode.season, episode: episode.episode, episodeName: episode.name },
    }));
    useLibrary.getState().setManyWatched(entries, true);
    useUi.getState().toast(t("title.episode.markedUpTo", { count: fresh.length }), "success", {
      label: t("feed.dismissed.undo"),
      run: () => useLibrary.getState().setManyWatched(entries, false),
    });
  };

  const toggleSeasonWatched = () =>
    useLibrary.getState().setManyWatched(
      list.map((episode) => ({
        unitKey: keyOf(episode),
        context: { title, season: episode.season, episode: episode.episode, episodeName: episode.name },
      })),
      !seasonWatched,
    );

  return (
    <section className="section" ref={sectionRef}>
      <div className="section__head">
        <h2>{t("title.episodes")}</h2>
        {total > 0 && <span className="section__note">{note}</span>}
        <div className="section__actions">
          {total > 0 && (
            <button className="button" onClick={toggleSeasonWatched}>
              <CheckCheck size={16} />
              {seasonWatched ? t("title.season.unmark") : long ? t("title.arc.markWatched") : t("title.season.markWatched")}
            </button>
          )}
          <button className="button" onClick={() => openAddSource({ target })}>
            <Plus size={16} />
            {t("common.addTorrent")}
          </button>
        </div>
      </div>

      {layout ? (
        <div className="arc-bar">
          <form className="arc-bar__jump" onSubmit={goTo}>
            <input
              className="input arc-bar__input"
              inputMode="numeric"
              aria-label={t("title.arcs.jump")}
              placeholder={t("title.arcs.jump")}
              value={jump}
              onChange={(event) => setJump(event.target.value.replace(/\D/g, "").slice(0, 4))}
            />
            <button className="button button--small" type="submit" disabled={!jump}>
              {t("title.arcs.go")}
            </button>
          </form>
          <div className="chips chips--scroll arc-bar__chips" role="tablist" aria-label={t("title.arcs")}>
            {layout.arcs.map((arc) => {
              const active = arc.season === season && (!currentArc || currentArc.first === arc.first);
              return (
                <button
                  key={`${arc.season}:${arc.first}`}
                  role="tab"
                  aria-selected={active}
                  className={`chip ${active ? "is-active" : ""}`}
                  onClick={() => {
                    setChunkFirst(arc.chunk ? arc.first : null);
                    onSeasonChange(arc.season);
                  }}
                >
                  {arcLabel(arc, details)}
                </button>
              );
            })}
            {details.seasons
              .filter((item) => !inLayout(layout, item.seasonNumber))
              .map((item) => (
                <button
                  key={item.seasonNumber}
                  role="tab"
                  aria-selected={item.seasonNumber === season}
                  className={`chip ${item.seasonNumber === season ? "is-active" : ""}`}
                  onClick={() => onSeasonChange(item.seasonNumber)}
                >
                  {item.seasonNumber === specialsSeason ? t("common.specials") : item.name || t("common.season", { season: item.seasonNumber })}
                </button>
              ))}
          </div>
        </div>
      ) : (
        details.seasons.length > 1 && (
          <div className="chips chips--scroll">
            {details.seasons.map((item) => (
              <button
                key={item.seasonNumber}
                className={`chip ${item.seasonNumber === season ? "is-active" : ""}`}
                onClick={() => onSeasonChange(item.seasonNumber)}
              >
                {item.seasonNumber === specialsSeason ? t("common.specials") : t("common.season", { season: item.seasonNumber })}
              </button>
            ))}
          </div>
        )
      )}

      {episodes.error ? (
        <CatalogError onRetry={episodes.reload} />
      ) : episodes.loading ? (
        <div className="episode-list">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="episode episode--skeleton" />
          ))}
        </div>
      ) : (
        <div className="episode-list">
          {(episodes.data ?? []).map((episode) => (
            <EpisodeRow
              key={episode.episode}
              title={title}
              episode={episode}
              target={target}
              onMarkUpTo={season !== specialsSeason && (episode.episode > 1 || season > 1) ? () => void markUpTo(episode) : null}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function useResumeEpisode(details: Details | null): { season: number; episode: number; name?: string; resumed: boolean } | null {
  const progress = useLibrary((state) => state.progress);
  const sources = useLibrary((state) => state.sources);
  return useMemo(() => {
    if (!details || details.type !== "tv") return null;
    const prefix = `tv:${details.id}:`;

    const inProgress = Object.entries(progress)
      .filter(([key, item]) => key.startsWith(prefix) && !isWatched(item) && sources[key])
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)[0];
    if (inProgress) {
      const [, item] = inProgress;
      return { season: item.season ?? 1, episode: item.episode ?? 1, name: item.episodeName, resumed: true };
    }

    const candidates = Object.keys(sources)
      .filter((key) => key.startsWith(prefix) && !isWatched(progress[key]))
      .map((key) => key.slice(prefix.length).split(":").map(Number))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const first = candidates.find(([seasonNumber]) => seasonNumber !== specialsSeason) ?? candidates[0];
    return first ? { season: first[0], episode: first[1], resumed: false } : null;
  }, [details, progress, sources]);
}

function TrackerHint({ details, onFind }: { details: Details; onFind: () => void }) {
  const { t, tn } = useT();
  const checked = useAvailability((state) => checkedOf(state.known, details));

  useEffect(() => {
    checkAvailability([details], true);
  }, [details]);

  if (!checked) return null;
  if (!checked.found) return <div className="title-hero__tracker is-missing">{t("title.tracker.none")}</div>;
  return (
    <div className="title-hero__tracker">
      <CircleCheck size={15} />
      {checked.quality ? t("title.tracker.found", { quality: checked.quality }) : t("title.tracker.foundPlain")}
      <span>· {tn("cards.available.seeds", checked.seeds)}</span>
      <button onClick={onFind}>{t("title.episode.find")}</button>
    </div>
  );
}

function TitleRating({ imdbId, catalogRating }: { imdbId: string | null; catalogRating: number }) {
  const imdb = useAsync(() => (imdbId ? backend.imdbRating(imdbId) : Promise.resolve(null)), [imdbId]);
  const { t, tn, locale } = useT();
  if (imdb.loading) return null;
  if (imdb.data) {
    return (
      <span className="rating" title={tn("title.rating.imdb", imdb.data.votes, { votes: imdb.data.votes.toLocaleString(locale) })}>
        <Star size={13} fill="currentColor" />
        {imdb.data.rating.toFixed(1)}
      </span>
    );
  }
  if (catalogRating <= 0) return null;
  return (
    <span className="rating" title={t("title.rating.tmdb")}>
      <Star size={13} fill="currentColor" />
      {catalogRating.toFixed(1)}
    </span>
  );
}

export default function TitlePage() {
  const params = useParams();
  const type = params.type as MediaType;
  const id = Number(params.id);
  const [searchParams, setSearchParams] = useSearchParams();
  const { t, tn, language } = useT();
  const [trailerTitleId, setTrailerTitleId] = useState<number | null>(null);

  const details = useAsync(() => tmdb.details(type, id), [type, id]);
  const data = details.data && details.data.id === id ? details.data : null;
  const title = useMemo(() => (data ? toTitleRef(data) : null), [data]);

  useEffect(() => {
    if (title) recordActivity("title.open", { title: titleOf(title) });
  }, [title?.type, title?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const localized = useAsync(
    async () => (data && needsLocalizing(data, language) ? { id: data.id, type: data.type, ...(await localizedTexts(data, language)) } : null),
    [data, language],
  );
  const texts = localized.data && data && localized.data.id === data.id && localized.data.type === data.type ? localized.data : null;
  const shownTitle = texts?.title || data?.title || "";
  const shownOverview = texts?.overview || data?.overview || "";
  const shownGenres = texts?.genres ?? data?.genres ?? [];
  const shownRef = useMemo(() => (title ? { ...title, title: shownTitle || title.title } : null), [title, shownTitle]);

  const movieSources = useLibrary((state) => state.sources[unitKey("movie", id)]);
  const resume = useResumeEpisode(data);
  const layoutState = useAsync(
    () => (data && type === "tv" ? episodeLayout(data.id, data.seasons, data.isAnime) : Promise.resolve(null)),
    [data?.id, data?.seasons, type],
  );
  const layout = layoutState.data ?? null;
  const [focusEpisode, setFocusEpisode] = useState<number | null>(null);
  const { play, openAddSource, setPageTarget } = useUi.getState();

  const firstSeason = data?.seasons.find((season) => season.seasonNumber !== specialsSeason)?.seasonNumber ?? data?.seasons[0]?.seasonNumber ?? 1;
  const requestedSeason = searchParams.get("s");
  const season = requestedSeason !== null ? Number(requestedSeason) : (resume?.season ?? firstSeason);

  const target = useMemo<AddSourceTarget | null>(
    () =>
      data && title
        ? {
            title,
            originalTitle: data.originalTitle,
            originalLanguage: data.language,
            seasons: data.seasons,
            defaultSeason: season,
            ...(layoutState.loading ? {} : { layout }),
          }
        : null,
    [data, title, season, layout, layoutState.loading],
  );

  useEffect(() => {
    setPageTarget(target);
    return () => setPageTarget(null);
  }, [target, setPageTarget]);

  // The page may stay alive hidden in the page stack: a trailer must not keep playing behind it.
  useEffect(() => () => setTrailerTitleId(null), []);

  useEffect(() => {
    if (!data || !shownRef || localized.loading) return;
    const regularEpisodes = data.seasons
      .filter((item) => item.seasonNumber !== specialsSeason)
      .reduce((sum, item) => sum + item.episodeCount, 0);
    useLibrary.getState().noteTitleDetails(shownRef, data.type === "tv" ? regularEpisodes : undefined);
  }, [data, shownRef, localized.loading]);

  const heroUnit = type === "movie" ? unitKey("movie", id) : resume ? unitKey("tv", id, resume.season, resume.episode) : null;
  const heroWarm = useHoverWarm(heroUnit);

  useEffect(() => {
    if (data) warmTitleResume(type, data.id);
  }, [type, data?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (details.error) {
    return (
      <div className="page">
        <CatalogError onRetry={details.reload} />
      </div>
    );
  }
  if (!data || !title || !shownRef || !target) return <div className="page page--flush"><div className="title-hero title-hero--skeleton" /></div>;

  const backdrop = imageUrl(data.backdrop, "w1280");
  const regularSeasons = data.seasons.filter((item) => item.seasonNumber !== specialsSeason).length;
  const seasonPoster = type === "tv" && regularSeasons > 1 && season !== specialsSeason ? data.seasons.find((item) => item.seasonNumber === season)?.poster : null;
  const poster = imageUrl(seasonPoster ?? data.poster, "w500");
  const bestMovieSource = type === "movie" && movieSources?.length ? sortSources(movieSources)[0] : null;

  const meta = [
    data.year,
    typeLabel(data),
    type === "movie"
      ? formatRuntime(data.runtimeMinutes)
      : layout
        ? tn("common.episodes", layout.last)
        : data.seasons.length > 0
          ? tn("title.seasons", data.seasons.filter((s) => s.seasonNumber !== specialsSeason).length || 1)
          : "",
    data.countries.slice(0, 2).join(", "),
  ].filter(Boolean);

  const playResume = () => {
    if (bestMovieSource) {
      play({ title: shownRef, unitKey: unitKey("movie", id) });
      return;
    }
    if (resume) {
      play({
        title: shownRef,
        unitKey: unitKey("tv", id, resume.season, resume.episode),
        season: resume.season,
        episode: resume.episode,
        episodeName: resume.name,
      });
    }
  };
  const canPlay = Boolean(bestMovieSource || resume);
  const playLabel = resume
    ? `${resume.resumed ? t("title.resume") : t("title.watch")} · ${layout && inLayout(layout, resume.season) ? t("tracker.long.single", { episode: resume.episode }) : t("title.episodeShort", { season: resume.season, episode: resume.episode })}`
    : t("title.watch");

  return (
    <div className="page page--flush">
      <section className="title-hero">
        {backdrop && <img className="title-hero__backdrop" src={backdrop} alt="" draggable={false} />}
        <div className="title-hero__shade" />
        <div className="title-hero__body">
          <div className="title-hero__poster">{poster && <img src={poster} alt="" draggable={false} />}</div>
          <div className="title-hero__info">
            <h1>{shownTitle}</h1>
            {data.originalTitle && data.originalTitle !== shownTitle && <div className="title-hero__original">{data.originalTitle}</div>}
            <div className="title-hero__meta">
              <TitleRating imdbId={data.imdbId} catalogRating={data.rating} />
              {meta.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
            {shownGenres.length > 0 && (
              <div className="title-hero__genres">
                {shownGenres.map((genre) => (
                  <span key={genre} className="tag">
                    {genre}
                  </span>
                ))}
              </div>
            )}
            {data.directors.length > 0 && (
              <div className="title-hero__crew">
                <span>{tn(type === "movie" ? "person.directors" : "person.creators", Math.min(data.directors.length, namedDirectorCount))}</span>
                {data.directors.slice(0, namedDirectorCount).map((person) => (
                  <Link key={person.id} to={`/person/${person.id}`}>
                    {person.name}
                  </Link>
                ))}
              </div>
            )}
            {data.tagline && <div className="title-hero__tagline">{data.tagline}</div>}
            <Overview text={shownOverview || t("title.noOverview")} />
            <div className="title-hero__actions">
              {canPlay ? (
                <button className="button button--primary button--large" {...heroWarm} onClick={playResume}>
                  <Play size={18} fill="currentColor" />
                  {playLabel}
                </button>
              ) : (
                <button className="button button--primary button--large" onClick={() => openAddSource({ target })}>
                  <Plus size={18} />
                  {t("common.addTorrent")}
                </button>
              )}
              <StatusMenu title={shownRef} />
              {data.videos.length > 0 && (
                <button className="button button--large" aria-haspopup="dialog" onClick={() => setTrailerTitleId(id)}>
                  <Clapperboard size={18} />
                  {t("title.trailer")}
                </button>
              )}
            </div>
            {(type === "tv" || !bestMovieSource) && <TrackerHint details={data} onFind={() => openAddSource({ target })} />}
            <RatingStars title={shownRef} />
          </div>
        </div>
      </section>

      <div className="page__rows">
        {type === "movie" ? (
          <MovieSources title={shownRef} target={target} />
        ) : (
          <SeriesEpisodes
            details={data}
            title={shownRef}
            season={season}
            layout={layout}
            focusEpisode={focusEpisode ?? (resume && resume.season === season ? resume.episode : null)}
            target={target}
            onSeasonChange={(next, episode) => {
              setFocusEpisode(episode ?? null);
              setSearchParams({ s: String(next) }, { replace: true });
            }}
          />
        )}

        {data.cast.length > 0 && (
          <section className="section">
            <div className="section__head">
              <h2>{t("title.cast")}</h2>
            </div>
            <div className="cast">
              {data.cast.map((person) => {
                const photo = imageUrl(person.photo, "w185");
                return (
                  <Link key={person.id} className="cast__person" to={`/person/${person.id}`} draggable={false}>
                    <div className="cast__photo">{photo ? <img src={photo} alt="" loading="lazy" draggable={false} /> : person.name.slice(0, 1)}</div>
                    <strong>{person.name}</strong>
                    <span>{person.character}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        <Gallery type={type} id={id} />

        {data.collection && <FranchiseRow collection={data.collection} currentId={id} />}

        {data.isAnime && <AnimeOrder names={[data.originalTitle, data.title]} type={type} year={Number(data.year) || null} />}

        {data.recommendations.length > 0 && <PosterRow title={t("title.similar")} items={data.recommendations} />}
      </div>

      {trailerTitleId === id && data.videos.length > 0 && (
        <TrailerOverlay title={data.title} videos={data.videos} onClose={() => setTrailerTitleId(null)} />
      )}
    </div>
  );
}
