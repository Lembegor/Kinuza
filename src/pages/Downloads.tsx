import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpToLine, ChevronDown, Download, FolderOpen, GripVertical, HardDrive, Pause, Play, Plus, Trash2, Users } from "lucide-react";
import { EmptyState } from "../components/Cards";
import { backend, describeError, isDesktop, type TorrentView } from "../lib/backend";
import { formatBytes, formatEta, formatSpeed } from "../lib/format";
import { t, tn, useT, type MessageKey } from "../lib/i18n";
import { imageUrl } from "../lib/tmdb";
import { isWatched, useLibrary, type TitleRef } from "../state/library";
import { useSettings } from "../state/settings";
import { etaSeconds, isDownload, torrentProgress, useTorrents, type SpeedSample } from "../state/torrents";
import { useUi } from "../state/ui";
import { useHoverWarm } from "../state/warmup";

const stateLabels: Record<string, MessageKey> = {
  initializing: "downloads.state.initializing",
  paused: "downloads.state.paused",
  queued: "status.queued",
  error: "downloads.state.error",
};

const mapBuckets = 160;
const mapRefreshMs = 4000;
const diskRefreshMs = 30_000;

interface Unit {
  unitKey: string;
  sourceId: string;
  fileIndex: number;
  season?: number;
  episode?: number;
}

interface TorrentInfo {
  title: TitleRef | null;
  path: string | null;
  units: Unit[];
  next: Unit | null;
}

interface Ordering {
  dragging: string | null;
  over: string | null;
  begin: (infoHash: string, label: string, event: React.PointerEvent) => void;
  focus: (infoHash: string) => void;
}

const dragThreshold = 6;

const heroTarget = "hero";

const OrderingContext = createContext<Ordering | null>(null);

function byQueue(a: TorrentView, b: TorrentView): number {
  return Number(Boolean(b.focused)) - Number(Boolean(a.focused)) || (a.queueOrder ?? 0) - (b.queueOrder ?? 0) || a.name.localeCompare(b.name);
}

function isOnlineOnly(torrent: TorrentView): boolean {
  return torrent.files.length > 0 && torrent.files.every((file) => !file.included);
}

function statusText(torrent: TorrentView): string {
  if (torrent.state !== "live") {
    const label = stateLabels[torrent.state];
    return label ? t(label) : torrent.state;
  }
  if (isOnlineOnly(torrent)) return t("downloads.status.online");
  if (torrent.finished) return t("downloads.status.seeding");
  const eta = formatEta(etaSeconds(torrent));
  return eta ? t("downloads.status.remaining", { time: eta }) : t("downloads.status.searching");
}

function isWaiting(torrent: TorrentView): boolean {
  return !torrent.finished && (torrent.state === "paused" || torrent.state === "queued");
}

async function run(action: Promise<void>): Promise<void> {
  try {
    await action;
    await useTorrents.getState().refresh();
  } catch (error) {
    useUi.getState().toast(describeError(error), "error");
  }
}

async function openFolder(path: string): Promise<void> {
  if (!isDesktop) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path).catch((error) => useUi.getState().toast(describeError(error), "error"));
}

function useTorrentInfo(torrent: TorrentView): TorrentInfo {
  const sources = useLibrary((state) => state.sources);
  const progress = useLibrary((state) => state.progress);
  const tracked = useLibrary((state) => state.tracked);
  return useMemo(() => {
    const units: Unit[] = Object.entries(sources)
      .flatMap(([unitKey, list]) => list.filter((source) => source.infoHash === torrent.infoHash).map((source) => ({ unitKey, source })))
      .map(({ unitKey, source }) => {
        const [type, , season, episode] = unitKey.split(":");
        const tv = type === "tv" && Number.isFinite(Number(season)) && Number.isFinite(Number(episode));
        return { unitKey, sourceId: source.id, fileIndex: source.fileIndex, ...(tv ? { season: Number(season), episode: Number(episode) } : {}) };
      })
      .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
    if (units.length === 0) return { title: null, path: null, units, next: null };
    const [type, id] = units[0].unitKey.split(":");
    const known = progress[units[0].unitKey]?.title ?? tracked[`${type}:${id}`];
    const title: TitleRef = known
      ? { type: known.type, id: known.id, title: known.title, poster: known.poster, backdrop: known.backdrop, year: known.year }
      : { type: type === "tv" ? "tv" : "movie", id: Number(id), title: torrent.name, poster: null, backdrop: null, year: "" };
    const unfinished = units.filter((unit) => !isWatched(progress[unit.unitKey]));
    const started = unfinished
      .filter((unit) => (progress[unit.unitKey]?.position ?? 0) > 0)
      .sort((a, b) => (progress[b.unitKey]?.updatedAt ?? 0) - (progress[a.unitKey]?.updatedAt ?? 0))[0];
    return { title, path: `/title/${type}/${id}`, units, next: started ?? unfinished[0] ?? units[0] };
  }, [sources, progress, tracked, torrent.infoHash, torrent.name]);
}

function unitLabel(unit: Unit): string {
  return unit.season !== undefined ? t("downloads.watch.episode", { season: unit.season, episode: unit.episode ?? "" }) : t("title.watch");
}

function seasonsLabel(units: Unit[]): string {
  const seasons = [...new Set(units.flatMap((unit) => (unit.season && unit.season > 0 ? [unit.season] : [])))].sort((a, b) => a - b);
  if (seasons.length === 0) return "";
  if (seasons.length === 1) return t("common.season", { season: seasons[0] });
  return t("downloads.group.seasons", { from: seasons[0], to: seasons[seasons.length - 1] });
}

function usePlayUnit(info: TorrentInfo) {
  const play = useUi((state) => state.play);
  const progress = useLibrary((state) => state.progress);
  return (unit: Unit) => {
    if (!info.title) return;
    play({
      title: info.title,
      unitKey: unit.unitKey,
      season: unit.season,
      episode: unit.episode,
      episodeName: progress[unit.unitKey]?.episodeName,
      preferredSourceId: unit.sourceId,
    });
  };
}

function WatchButton({ info, torrent, large }: { info: TorrentInfo; torrent: TorrentView; large?: boolean }) {
  const playUnit = usePlayUnit(info);
  const hoverWarm = useHoverWarm(info.next?.unitKey ?? null, info.next?.sourceId);
  if (!info.next) return null;
  const next = info.next;
  return (
    <button
      className={`dl-watch ${large ? "dl-watch--large" : ""}`}
      {...hoverWarm}
      title={torrent.finished ? undefined : t("downloads.watch.whileDownloading")}
      onClick={(event) => {
        event.stopPropagation();
        playUnit(next);
      }}
    >
      <Play size={large ? 16 : 14} fill="currentColor" />
      <span>{unitLabel(next)}</span>
    </button>
  );
}

function Sparkline({ samples }: { samples: SpeedSample[] }) {
  const width = 300;
  const height = 48;
  const peak = Math.max(1, ...samples.map((sample) => Math.max(sample.down, sample.up)));
  const step = samples.length > 1 ? width / (samples.length - 1) : width;
  const line = (pick: (sample: SpeedSample) => number) =>
    samples.map((sample, index) => `${(index * step).toFixed(1)},${(height - 3 - (pick(sample) / peak) * (height - 8)).toFixed(1)}`).join(" ");
  const down = line((sample) => sample.down);
  return (
    <svg className="dl-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {samples.length > 1 && <polygon className="dl-spark__area" points={`0,${height} ${down} ${width},${height}`} />}
      <polyline className="dl-spark__down" points={down} />
      <polyline className="dl-spark__up" points={line((sample) => sample.up)} />
    </svg>
  );
}

const numberedTilesLimit = 60;

type TileState = "ready" | "loading" | "queued" | "online";

function EpisodeStrip({ info, torrent }: { info: TorrentInfo; torrent: TorrentView }) {
  const progress = useLibrary((state) => state.progress);
  const playUnit = usePlayUnit(info);
  const [busy, setBusy] = useState<number[]>([]);
  const episodes = info.units.filter((unit) => unit.season !== undefined);
  if (episodes.length < 2) return null;
  const fileFor = (unit: Unit) => torrent.files.find((item) => item.index === unit.fileIndex);
  const share = (unit: Unit) => {
    const file = fileFor(unit);
    return file && file.length > 0 ? Math.min(1, file.downloaded / file.length) : 0;
  };
  const included = (unit: Unit) => fileFor(unit)?.included ?? true;
  const stateOf = (unit: Unit): TileState => {
    const done = share(unit);
    if (done >= 1) return "ready";
    if (!included(unit)) return "online";
    return done > 0 ? "loading" : "queued";
  };
  const ready = episodes.filter((unit) => stateOf(unit) === "ready").length;
  const online = episodes.filter((unit) => stateOf(unit) === "online");
  const chosen = episodes.length - online.length;
  const numbered = episodes.length <= numberedTilesLimit;
  const downloadDir = () => useSettings.getState().downloadDir || null;

  const change = (files: number[], action: Promise<void>) => {
    setBusy((current) => [...current, ...files]);
    void run(action).finally(() => setBusy((current) => current.filter((file) => !files.includes(file))));
  };
  const toggle = (unit: Unit) => {
    const state = stateOf(unit);
    if (state === "ready") {
      playUnit(unit);
      return;
    }
    if (state === "online") change([unit.fileIndex], backend.selectFiles(torrent.infoHash, [unit.fileIndex], downloadDir()));
    else change([unit.fileIndex], backend.excludeFiles(torrent.infoHash, [unit.fileIndex]));
  };
  const hint = (unit: Unit) => {
    const state = stateOf(unit);
    const name = t("common.seasonEpisode", { season: unit.season ?? "", episode: unit.episode ?? "" });
    const status =
      state === "ready"
        ? t("downloads.tile.ready")
        : state === "loading"
          ? t("downloads.tile.loading", { percent: Math.floor(share(unit) * 100) })
          : state === "queued"
            ? t("downloads.tile.queued")
            : t("downloads.tile.online");
    const watched = isWatched(progress[unit.unitKey]) ? ` · ${t("downloads.episode.watched")}` : "";
    return `${name}${watched}\n${status}`;
  };

  return (
    <div className="dl-episodes" onClick={(event) => event.stopPropagation()}>
      <div className={`dl-tiles ${numbered ? "is-numbered" : ""}`}>
        {episodes.map((unit) => {
          const state = stateOf(unit);
          const done = share(unit);
          return (
            <div
              key={unit.unitKey}
              className={`dl-tile is-${state} ${isWatched(progress[unit.unitKey]) ? "is-watched" : ""} ${info.next?.unitKey === unit.unitKey ? "is-next" : ""} ${busy.includes(unit.fileIndex) ? "is-busy" : ""}`}
              style={state === "loading" ? { ["--fill" as string]: `${Math.max(6, Math.round(done * 100))}%` } : undefined}
            >
              <button
                className="dl-tile__toggle"
                title={hint(unit)}
                aria-label={hint(unit)}
                aria-pressed={state !== "online"}
                onClick={() => toggle(unit)}
              >
                {numbered && <span>{unit.episode}</span>}
              </button>
              {numbered && state !== "ready" && (
                <button
                  className="dl-tile__play"
                  title={t("downloads.tile.play", { episode: unit.episode ?? "" })}
                  aria-label={t("downloads.tile.play", { episode: unit.episode ?? "" })}
                  onClick={() => playUnit(unit)}
                >
                  <Play size={8} fill="currentColor" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="dl-episodes__foot">
        <span className="dl-episodes__note">
          {online.length > 0
            ? t("downloads.episodes.partial", { ready, chosen, online: online.length })
            : t("downloads.episodes.ready", { ready, total: episodes.length })}
        </span>
        {online.length > 0 && (
          <button
            className="dl-link"
            onClick={() => change(online.map((unit) => unit.fileIndex), backend.selectFiles(torrent.infoHash, online.map((unit) => unit.fileIndex), downloadDir()))}
          >
            {t("downloads.episodes.chooseAll")}
          </button>
        )}
        <span className="dl-legend">
          <i className="dl-legend__ready" />
          {t("downloads.legend.ready")}
          <i className="dl-legend__loading" />
          {t("downloads.legend.loading")}
          <i className="dl-legend__queued" />
          {t("downloads.legend.queued")}
          <i className="dl-legend__online" />
          {t("downloads.legend.online")}
        </span>
      </div>
    </div>
  );
}

function PieceMap({ torrent, unit }: { torrent: TorrentView; unit: Unit }) {
  const [map, setMap] = useState<number[] | null>(null);
  const saved = useLibrary((state) => state.progress[unit.unitKey]);
  const file = torrent.files.find((item) => item.index === unit.fileIndex);
  const complete = Boolean(file && file.length > 0 && file.downloaded >= file.length);

  useEffect(() => {
    if (complete) {
      setMap(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      backend
        .torrentFileMap(torrent.infoHash, unit.fileIndex, mapBuckets)
        .then((next) => !cancelled && setMap(next))
        .catch(() => !cancelled && setMap(null));
    void load();
    const timer = setInterval(() => void load(), mapRefreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [torrent.infoHash, unit.fileIndex, complete]);

  const cells = complete ? Array.from({ length: mapBuckets }, () => 255) : map;
  const marker = saved && saved.duration > 1 && !isWatched(saved) ? Math.min(1, saved.position / saved.duration) : null;
  if (!cells) return null;
  return (
    <div className="dl-map">
      <div className="dl-map__bar">
        {cells.map((value, index) => (
          <i key={index} style={{ ["--have" as string]: `${Math.round((value / 255) * 100)}%` }} />
        ))}
        {marker !== null && <span className="dl-map__marker" style={{ left: `${marker * 100}%` }} />}
      </div>
      <span className="dl-map__note">{marker !== null ? t("downloads.map.markerNote") : t("downloads.map.note")}</span>
    </div>
  );
}

function Details({ torrent, info }: { torrent: TorrentView; info: TorrentInfo }) {
  const { t } = useT();
  const unit = info.next;
  return (
    <div className="dl-details" onClick={(event) => event.stopPropagation()}>
      {unit && (
        <>
          <div className="dl-details__label">
            {unit.season !== undefined ? t("downloads.map.episode", { season: unit.season, episode: unit.episode ?? "" }) : t("downloads.map.title")}
          </div>
          <PieceMap torrent={torrent} unit={unit} />
        </>
      )}
      <dl className="dl-stats">
        <div>
          <dt>{t("downloads.stat.peers")}</dt>
          <dd>{torrent.state === "live" ? torrent.peers : "-"}</dd>
        </div>
        <div>
          <dt>{t("downloads.stat.uploaded")}</dt>
          <dd>{formatBytes(torrent.uploadedBytes)}</dd>
        </div>
        <div>
          <dt>{t("downloads.stat.files")}</dt>
          <dd>{torrent.files.filter((file) => file.included).length}</dd>
        </div>
        <div className="dl-stats__wide">
          <dt>{t("downloads.stat.folder")}</dt>
          <dd title={torrent.outputFolder}>{torrent.outputFolder}</dd>
        </div>
      </dl>
    </div>
  );
}

function Actions({ torrent, canFocus }: { torrent: TorrentView; canFocus?: boolean }) {
  const ordering = useContext(OrderingContext);
  const askConfirm = useUi((state) => state.askConfirm);
  const removeFromLibrary = useLibrary((state) => state.removeTorrent);
  const paused = torrent.state === "paused" || torrent.state === "queued";
  const remove = () =>
    askConfirm({
      title: t("downloads.remove.title"),
      message: torrent.name,
      confirmLabel: t("common.delete"),
      optionLabel: t("downloads.remove.files"),
      optionChecked: true,
      danger: true,
      onConfirm: (deleteFiles) => {
        void run(backend.remove(torrent.infoHash, deleteFiles).then(() => removeFromLibrary(torrent.infoHash)));
      },
    });
  return (
    <div className="dl-actions" onClick={(event) => event.stopPropagation()}>
      {torrent.finished && (
        <button
          className={`torrent__upload ${torrent.uploadEnabled ? "is-on" : ""}`}
          aria-pressed={torrent.uploadEnabled}
          aria-label={t(torrent.uploadEnabled ? "downloads.upload.on" : "downloads.upload.off")}
          title={t(torrent.uploadEnabled ? "downloads.upload.onNote" : "downloads.upload.offNote")}
          onClick={() => void run(backend.setUpload(torrent.infoHash, !torrent.uploadEnabled))}
        >
          <ArrowUp size={14} />
          <span>{t(torrent.uploadEnabled ? "downloads.upload.on" : "downloads.upload.off")}</span>
        </button>
      )}
      {canFocus && ordering && (
        <button className="icon-button" aria-label={t("downloads.focus")} title={t("downloads.focus")} onClick={() => ordering.focus(torrent.infoHash)}>
          <ArrowUpToLine size={17} />
        </button>
      )}
      {!torrent.finished && (
        <button
          className="icon-button"
          aria-label={paused ? t("downloads.resume") : t("downloads.pause")}
          title={paused ? t("downloads.resume") : t("downloads.pause")}
          onClick={() => void run(paused ? backend.resume(torrent.infoHash) : backend.pause(torrent.infoHash))}
        >
          {paused ? <Play size={17} /> : <Pause size={17} />}
        </button>
      )}
      <button className="icon-button" aria-label={t("downloads.openFolder")} title={t("downloads.openFolder")} onClick={() => void openFolder(torrent.outputFolder)}>
        <FolderOpen size={17} />
      </button>
      <button className="icon-button" aria-label={t("common.delete")} title={t("common.delete")} onClick={remove}>
        <Trash2 size={17} />
      </button>
    </div>
  );
}

function Poster({ title, large }: { title: TitleRef | null; large?: boolean }) {
  const src = title ? imageUrl(title.poster, "w185") : null;
  return <div className={`dl-poster ${large ? "dl-poster--large" : ""}`}>{src ? <img src={src} alt="" loading="lazy" draggable={false} /> : <Download size={large ? 26 : 16} />}</div>;
}

function Meta({ torrent, partial }: { torrent: TorrentView; partial?: boolean }) {
  return (
    <div className="dl-meta">
      <span>{partial && torrent.finished && torrent.state === "live" ? t("downloads.status.chosenDone") : statusText(torrent)}</span>
      <span>
        {isOnlineOnly(torrent)
          ? t("downloads.onDisk", { size: formatBytes(torrent.files.reduce((sum, file) => sum + file.downloaded, 0)) })
          : t("downloads.progress", { done: formatBytes(torrent.progressBytes), total: formatBytes(torrent.totalBytes) })}
      </span>
      {torrent.state === "live" && !torrent.finished && (
        <>
          <span className="dl-meta__stat">
            <ArrowDown size={13} />
            {formatSpeed(torrent.downloadSpeed)}
          </span>
          <span className="dl-meta__stat">
            <Users size={13} />
            {tn("downloads.peers", torrent.peers)}
          </span>
        </>
      )}
      {torrent.finished && torrent.uploadSpeed > 0 && (
        <span className="dl-meta__stat">
          <ArrowUp size={13} />
          {formatSpeed(torrent.uploadSpeed)}
        </span>
      )}
    </div>
  );
}

function NameLine({ torrent, info, large }: { torrent: TorrentView; info: TorrentInfo; large?: boolean }) {
  const badge = seasonsLabel(info.units);
  return (
    <div className={large ? "dl-hero__name" : "dl-row__name"}>
      {info.title && info.path ? (
        <Link to={info.path} className="dl-title" onClick={(event) => event.stopPropagation()}>
          {info.title.title}
        </Link>
      ) : (
        <span className="dl-title">{torrent.name}</span>
      )}
      {badge && <span className="dl-badge">{badge}</span>}
      {info.title && <span className="dl-file" title={torrent.name}>{torrent.name}</span>}
    </div>
  );
}

function Hero({ torrent }: { torrent: TorrentView }) {
  const info = useTorrentInfo(torrent);
  const samples = useTorrents((state) => state.history[torrent.infoHash] ?? []);
  const [open, setOpen] = useState(false);
  const progress = torrentProgress(torrent);
  const peak = Math.max(0, ...samples.map((sample) => sample.down));
  const eta = formatEta(etaSeconds(torrent));
  const ordering = useContext(OrderingContext);
  const accepts = Boolean(ordering?.dragging && ordering.dragging !== torrent.infoHash);
  return (
    <section
      className={`dl-hero ${accepts && ordering?.over === heroTarget ? "is-drop" : ""} ${accepts ? "is-droppable" : ""}`}
      data-drop={heroTarget}
    >
      {accepts && <div className="dl-hero__drop">{t("downloads.dropFirst")}</div>}
      <Poster title={info.title} large />
      <div className="dl-hero__body">
        <NameLine torrent={torrent} info={info} large />
        <div className="dl-hero__facts">
          <span className="dl-hero__eta">{eta ? t("downloads.status.remaining", { time: eta }) : statusText(torrent)}</span>
          <span>{t("downloads.progress", { done: formatBytes(torrent.progressBytes), total: formatBytes(torrent.totalBytes) })}</span>
          <span className="dl-meta__stat">
            <Users size={13} />
            {tn("downloads.peers", torrent.peers)}
          </span>
        </div>
        <div className="dl-hero__graph">
          <Sparkline samples={samples} />
          <div className="dl-hero__speeds">
            <span className="dl-speed dl-speed--down">
              <ArrowDown size={14} />
              {formatSpeed(torrent.downloadSpeed)}
            </span>
            <span className="dl-speed dl-speed--up">
              <ArrowUp size={14} />
              {formatSpeed(torrent.uploadSpeed)}
            </span>
            {peak > 0 && <span className="dl-speed__peak">{t("downloads.peak", { speed: formatSpeed(peak) })}</span>}
          </div>
        </div>
        <div className="dl-hero__progress">
          <div className="bar">
            <i style={{ width: `${progress * 100}%` }} />
          </div>
          <span className="dl-hero__percent">{Math.floor(progress * 100)}%</span>
        </div>
        <EpisodeStrip info={info} torrent={torrent} />
        <div className="dl-hero__foot">
          <WatchButton info={info} torrent={torrent} large />
          <button className="dl-more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? t("downloads.details.hide") : t("downloads.details.show")}
            <ChevronDown size={15} className={open ? "is-open" : ""} />
          </button>
          <Actions torrent={torrent} />
        </div>
        {open && <Details torrent={torrent} info={info} />}
      </div>
    </section>
  );
}

function Row({ torrent }: { torrent: TorrentView }) {
  const info = useTorrentInfo(torrent);
  const [open, setOpen] = useState(false);
  const progress = torrentProgress(torrent);
  const ordering = useContext(OrderingContext);
  const movable = !torrent.finished && ordering !== null;
  const accepts = movable && Boolean(ordering?.dragging && ordering.dragging !== torrent.infoHash);
  return (
    <div
      className={`dl-row ${open ? "is-open" : ""} ${torrent.finished ? "is-finished" : ""} ${movable ? "is-movable" : ""} ${ordering?.dragging === torrent.infoHash ? "is-dragging" : ""} ${accepts && ordering?.over === torrent.infoHash ? "is-drop" : ""}`}
      data-drop={movable ? torrent.infoHash : undefined}
      onPointerDown={(event) => {
        if (movable) ordering?.begin(torrent.infoHash, info.title?.title ?? torrent.name, event);
      }}
    >
      <div className="dl-row__main" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setOpen(!open);
        }
      }}>
        {movable && (
          <span className="dl-row__grip" title={t("downloads.dragHint")} aria-hidden="true">
            <GripVertical size={16} />
          </span>
        )}
        <Poster title={info.title} />
        <div className="dl-row__body">
          <NameLine torrent={torrent} info={info} />
          <Meta torrent={torrent} partial={info.units.some((unit) => torrent.files.find((file) => file.index === unit.fileIndex)?.included === false)} />
          {!torrent.finished && (
            <div className="dl-row__progress">
              <div className="bar bar--thin">
                <i style={{ width: `${progress * 100}%` }} />
              </div>
              <span>{Math.floor(progress * 100)}%</span>
            </div>
          )}
          {torrent.error && <div className="torrent__error">{torrent.error}</div>}
          <EpisodeStrip info={info} torrent={torrent} />
        </div>
        <WatchButton info={info} torrent={torrent} />
        <Actions torrent={torrent} canFocus={movable} />
        <ChevronDown size={16} className={`dl-row__chevron ${open ? "is-open" : ""}`} />
      </div>
      {open && <Details torrent={torrent} info={info} />}
    </div>
  );
}

function Section({ title, torrents }: { title: string; torrents: TorrentView[] }) {
  if (torrents.length === 0) return null;
  return (
    <section className="dl-section">
      <h2 className="dl-section__title">
        {title} <span>{torrents.length}</span>
      </h2>
      <div className="dl-list">
        {torrents.map((torrent) => (
          <Row key={torrent.infoHash} torrent={torrent} />
        ))}
      </div>
    </section>
  );
}

function useFreeSpace(): number | null {
  const downloadDir = useSettings((state) => state.downloadDir);
  const [free, setFree] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      backend
        .storageReport(downloadDir || null)
        .then((report) => !cancelled && setFree(report.downloadsDisk?.freeBytes ?? null))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), diskRefreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [downloadDir]);
  return free;
}

export default function Downloads() {
  const everything = useTorrents((state) => state.list);
  const torrents = useMemo(() => everything.filter(isDownload), [everything]);
  const openAddSource = useUi((state) => state.openAddSource);
  const free = useFreeSpace();
  const { t } = useT();

  const totals = useMemo(
    () => ({
      down: torrents.reduce((sum, torrent) => sum + torrent.downloadSpeed, 0),
      up: torrents.reduce((sum, torrent) => sum + torrent.uploadSpeed, 0),
    }),
    [torrents],
  );
  const { hero, active, waiting, done } = useMemo(() => {
    const byName = (a: TorrentView, b: TorrentView) => a.name.localeCompare(b.name);
    const running = torrents.filter((torrent) => !torrent.finished && !isWaiting(torrent)).sort(byQueue);
    return {
      hero: running[0] ?? null,
      active: running.slice(1),
      waiting: torrents.filter(isWaiting).sort(byQueue),
      done: torrents.filter((torrent) => torrent.finished).sort(byName),
    };
  }, [torrents]);

  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  const layout = useRef({ active, waiting, hero });
  layout.current = { active, waiting, hero };

  const ordering = useMemo<Ordering>(() => {
    const focus = (infoHash: string) => void run(backend.focusTorrent(infoHash));
    const place = (moved: string, target: string | null) => {
      if (!target || target === moved) return;
      if (target === heroTarget) {
        focus(moved);
        return;
      }
      const { active: running, waiting: queued, hero: first } = layout.current;
      const queue = [...running, ...queued].map((torrent) => torrent.infoHash).filter((hash) => hash !== moved);
      const at = queue.indexOf(target);
      if (at < 0) return;
      queue.splice(at, 0, moved);
      void run(backend.reorderTorrents([...(first ? [first.infoHash] : []), ...queue]));
    };
    const begin = (infoHash: string, label: string, event: React.PointerEvent) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button, a, input, select")) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      let moving = false;
      let target: string | null = null;
      const move = (next: PointerEvent) => {
        if (!moving && Math.hypot(next.clientX - startX, next.clientY - startY) < dragThreshold) return;
        if (!moving) {
          moving = true;
          setDragging(infoHash);
          document.body.classList.add("is-reordering");
        }
        next.preventDefault();
        setGhost({ x: next.clientX, y: next.clientY, label });
        const spot = document.elementFromPoint(next.clientX, next.clientY)?.closest<HTMLElement>("[data-drop]");
        const value = spot?.dataset.drop ?? null;
        target = value && value !== infoHash ? value : null;
        setOver(target);
      };
      const finish = (apply: boolean) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("keydown", key, true);
        document.body.classList.remove("is-reordering");
        setGhost(null);
        setDragging(null);
        setOver(null);
        if (!moving) return;
        const swallow = (click: MouseEvent) => {
          click.stopPropagation();
          click.preventDefault();
        };
        window.addEventListener("click", swallow, true);
        setTimeout(() => window.removeEventListener("click", swallow, true), 0);
        if (apply) place(infoHash, target);
      };
      const up = () => finish(true);
      const key = (press: KeyboardEvent) => {
        if (press.key !== "Escape") return;
        press.stopPropagation();
        finish(false);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("keydown", key, true);
    };
    return { dragging, over, begin, focus };
  }, [dragging, over]);

  return (
    <div className="page">
      <div className="page__head">
        <h1>{t("downloads.title")}</h1>
        {torrents.length > 0 && (
          <span className="dl-totals">
            <span>
              <ArrowDown size={14} />
              {formatSpeed(totals.down)}
            </span>
            <span>
              <ArrowUp size={14} />
              {formatSpeed(totals.up)}
            </span>
            {free !== null && (
              <span>
                <HardDrive size={14} />
                {t("downloads.free", { size: formatBytes(free) })}
              </span>
            )}
          </span>
        )}
        <button className="button button--primary" onClick={() => openAddSource({ target: null })}>
          <Plus size={16} />
          {t("common.addTorrent")}
        </button>
      </div>
      {torrents.length === 0 ? (
        <EmptyState icon={<Download size={40} />} title={t("downloads.empty.title")} text={t("downloads.empty.text")} />
      ) : (
        <OrderingContext.Provider value={ordering}>
        <div className="dl-page">
          {hero && (
            <section className="dl-section">
              <h2 className="dl-section__title">
                {t("downloads.section.now")}
                {active.length + waiting.length > 0 && <small>{t("downloads.dragNote")}</small>}
              </h2>
              <Hero torrent={hero} />
            </section>
          )}
          <Section title={t("downloads.section.active")} torrents={active} />
          <Section title={t("downloads.section.waiting")} torrents={waiting} />
          <Section title={t("downloads.section.done")} torrents={done} />
        </div>
        {ghost && (
          <div className="dl-ghost" style={{ left: ghost.x, top: ghost.y }}>
            <GripVertical size={14} />
            {ghost.label}
          </div>
        )}
        </OrderingContext.Provider>
      )}
    </div>
  );
}
