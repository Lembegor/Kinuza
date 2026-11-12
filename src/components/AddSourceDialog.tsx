import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Download, FileUp, Link2, LoaderCircle, Play, Search, X } from "lucide-react";
import { backend, describeError, isDesktop, type TorrentFile, type TorrentPreview } from "../lib/backend";
import { formatBytes } from "../lib/format";
import { useT } from "../lib/i18n";
import { baseName, guessTitleQuery, isMagnetLink, isVideoFile, parseEpisode, parseQuality, resolveEpisodes } from "../lib/parse";
import { toSource } from "../lib/releaseUpdate";
import { imageUrl, tmdb, type MediaItem, type SeasonInfo } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { isTopDialog, useDialogFocus } from "../lib/useDialogFocus";
import { toTitleRef, unitKey, useLibrary } from "../state/library";
import { useReleaseWatch } from "../state/releaseWatch";
import { useSettings } from "../state/settings";
import { useTorrents } from "../state/torrents";
import { useUi, type AddSourceRequest, type AddSourceTarget } from "../state/ui";
import { typeLabel } from "./Cards";
import { TrackerSearch } from "./TrackerSearch";

const titleSearchDebounceMs = 350;
const titleSearchLimit = 8;
const playerFriendlyExtensions = /\.(mp4|m4v|mkv|webm|mov)$/i;

function videoFiles(preview: TorrentPreview): TorrentFile[] {
  const videos = preview.files.filter((file) => isVideoFile(file.path));
  return (videos.length > 0 ? videos : preview.files).sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { numeric: true }),
  );
}

function InputStep({
  busy,
  error,
  target,
  suggested,
  onLink,
  onRelease,
  onFile,
  onChooseTitle,
}: {
  busy: boolean;
  error: string;
  target: AddSourceTarget | null;
  suggested: AddSourceTarget | null;
  onLink: (link: string) => void;
  onRelease: (release: Promise<TorrentPreview>, topicId: string, season?: number, single?: boolean) => void;
  onFile: (path: string) => void;
  onChooseTitle: (target: AddSourceTarget) => void;
}) {
  const [value, setValue] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const valid = isMagnetLink(value);
  const { t } = useT();

  const pickFile = async () => {
    if (!isDesktop) {
      onFile("demo.torrent");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ title: t("addSource.file.dialog"), filters: [{ name: "Torrent", extensions: ["torrent"] }] });
    if (typeof picked === "string") onFile(picked);
  };

  if (busy) {
    return (
      <div className="add-loading">
        <LoaderCircle size={34} className="spin" />
        <strong>{t("addSource.loading.title")}</strong>
        <p>{t("addSource.loading.text")}</p>
      </div>
    );
  }

  return (
    <div className="add-input">
      {error && <p className="add-input__warning add-input__warning--top">{error}</p>}
      {target ? (
        <TrackerSearch target={target} onPick={onRelease} />
      ) : (
        <TitlePicker initialQuery="" guessedSeason={null} suggested={suggested} question={t("addSource.tracker.chooseTitle")} onPick={onChooseTitle} />
      )}
      <div className={`add-link ${linkOpen ? "is-open" : ""}`}>
        <button className="add-link__toggle" aria-expanded={linkOpen} onClick={() => setLinkOpen((open) => !open)}>
          <Link2 size={16} />
          {t("addSource.link.toggle")}
          <ChevronDown size={16} className="add-link__chevron" />
        </button>
        {linkOpen && (
          <div className="add-link__body">
      <label className="add-input__field">
        <Link2 size={18} />
        <input
          autoFocus
          value={value}
          placeholder={t("addSource.magnet.placeholder")}
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (isMagnetLink(text)) {
              event.preventDefault();
              setValue(text.trim());
              onLink(text.trim());
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && valid) onLink(value.trim());
          }}
        />
      </label>
      {value && !valid && <p className="add-input__warning">{t("addSource.magnet.invalid")}</p>}
      <div className="add-input__actions">
        <button className="button" onClick={() => void pickFile()}>
          <FileUp size={16} />
          {t("addSource.file.pick")}
        </button>
        <button className="button button--primary" disabled={!valid} onClick={() => onLink(value.trim())}>
          {t("addSource.continue")}
        </button>
      </div>
      <p className="add-input__hint">{t("addSource.file.dropHint")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function TitlePicker({
  initialQuery,
  guessedSeason,
  suggested,
  question,
  onPick,
}: {
  initialQuery: string;
  guessedSeason: number | null;
  suggested: AddSourceTarget | null;
  question: string;
  onPick: (target: AddSourceTarget) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [debounced, setDebounced] = useState(query);
  const [resolving, setResolving] = useState<number | null>(null);
  const { t } = useT();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), titleSearchDebounceMs);
    return () => clearTimeout(timer);
  }, [query]);

  const results = useAsync(() => (debounced ? tmdb.search(debounced) : Promise.resolve([])), [debounced]);

  const pick = async (item: MediaItem) => {
    setResolving(item.id);
    try {
      let seasons: SeasonInfo[] = [];
      if (item.type === "tv") seasons = (await tmdb.details("tv", item.id)).seasons;
      const firstRegular = seasons.find((season) => season.seasonNumber > 0)?.seasonNumber ?? 1;
      const guessed = guessedSeason;
      onPick({
        title: toTitleRef(item),
        originalTitle: item.originalTitle,
        originalLanguage: item.language,
        seasons,
        defaultSeason: guessed ?? firstRegular,
      });
    } catch (error) {
      useUi.getState().toast(describeError(error), "error");
      setResolving(null);
    }
  };

  return (
    <div className="title-picker">
      <p className="dialog__text">{question}</p>
      <label className="add-input__field">
        <Search size={18} />
        <input autoFocus value={query} placeholder={t("addSource.title.placeholder")} spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="title-picker__list">
        {suggested && (
          <button className="title-picker__item title-picker__item--suggested" disabled={resolving !== null} onClick={() => onPick(suggested)}>
            <img src={imageUrl(suggested.title.poster, "w185") ?? undefined} alt="" />
            <div>
              <strong>{suggested.title.title}</strong>
              <span>{t("addSource.title.suggested")}</span>
            </div>
          </button>
        )}
        {results.loading && <div className="title-picker__empty">{t("addSource.title.searching")}</div>}
        {!results.loading && (results.data ?? []).length === 0 && (
          <div className="title-picker__empty">{debounced ? t("addSource.title.notFound") : t("addSource.title.enter")}</div>
        )}
        {(results.data ?? []).slice(0, titleSearchLimit).map((item) => (
          <button key={`${item.type}:${item.id}`} className="title-picker__item" disabled={resolving !== null} onClick={() => void pick(item)}>
            <img src={imageUrl(item.poster, "w185") ?? undefined} alt="" />
            <div>
              <strong>{item.title}</strong>
              <span>{[item.year, typeLabel(item)].filter(Boolean).join(" · ")}</span>
            </div>
            {resolving === item.id && <LoaderCircle size={18} className="spin" />}
          </button>
        ))}
      </div>
    </div>
  );
}

interface EpisodeRowState {
  file: TorrentFile;
  included: boolean;
  season: number;
  episode: number | null;
}

function buildEpisodeRows(preview: TorrentPreview, seasons: SeasonInfo[], defaultSeason: number, pinnedSeason?: number): EpisodeRowState[] {
  const files = videoFiles(preview);
  const slots = resolveEpisodes(files.map((file) => file.path), seasons, defaultSeason, pinnedSeason);
  return files.map((file, index) => {
    const slot = slots[index];
    return { file, included: slot !== null, season: slot?.season ?? defaultSeason, episode: slot?.episode ?? null };
  });
}

type AddMode = "stream" | "download";

function AddActions({
  note,
  disabled,
  downloadLabel,
  downloadDisabled,
  onAdd,
}: {
  note?: string;
  disabled: boolean;
  downloadLabel?: string;
  downloadDisabled?: boolean;
  onAdd: (mode: AddMode) => void;
}) {
  const { t } = useT();
  return (
    <>
      <div className="dialog__actions">
        {note && <span className="dialog__note">{note}</span>}
        <button className="button" disabled={disabled || downloadDisabled} onClick={() => onAdd("download")}>
          <Download size={16} />
          {downloadLabel ?? t("common.download")}
        </button>
        <button className="button button--primary" disabled={disabled} onClick={() => onAdd("stream")}>
          <Play size={16} fill="currentColor" />
          {t("addSource.watchOnline")}
        </button>
      </div>
      <p className="dialog__hint">{t("addSource.modes.hint")}</p>
    </>
  );
}

function MovieMapping({ preview, onConfirm }: { preview: TorrentPreview; onConfirm: (files: TorrentFile[], mode: AddMode) => void }) {
  const files = useMemo(() => videoFiles(preview), [preview]);
  const preferred = useMemo(() => {
    const friendly = files.filter((file) => playerFriendlyExtensions.test(file.path));
    const pool = friendly.length > 0 ? friendly : files;
    return pool.reduce((best, file) => (file.length > best.length ? file : best), pool[0]);
  }, [files]);
  const [selected, setSelected] = useState(preferred?.index ?? 0);
  const { t } = useT();

  return (
    <>
      <p className="dialog__text">{t("addSource.movie.pick")}</p>
      <div className="file-list">
        {files.map((file) => (
          <label key={file.index} className={`file-row ${selected === file.index ? "is-selected" : ""}`}>
            <input type="radio" name="movie-file" checked={selected === file.index} onChange={() => setSelected(file.index)} />
            <span className="file-row__name" title={file.path}>
              {baseName(file.path)}
            </span>
            <span className="quality-tag">{parseQuality(file.path) || parseQuality(preview.name) || t("common.video")}</span>
            <span className="file-row__size">{formatBytes(file.length)}</span>
          </label>
        ))}
      </div>
      <AddActions disabled={files.length === 0} onAdd={(mode) => onConfirm(files.filter((file) => file.index === selected), mode)} />
    </>
  );
}

function SeriesMapping({
  preview,
  target,
  onConfirm,
}: {
  preview: TorrentPreview;
  target: AddSourceTarget;
  onConfirm: (rows: EpisodeRowState[], mode: AddMode) => void;
}) {
  const [rows, setRows] = useState(() => buildEpisodeRows(preview, target.seasons, target.defaultSeason, target.pinnedSeason));
  const { t, tn } = useT();

  const patchRow = (index: number, change: Partial<EpisodeRowState>) =>
    setRows((current) => current.map((row) => (row.file.index === index ? { ...row, ...change } : row)));
  const toggleRow = (row: EpisodeRowState) => patchRow(row.file.index, { included: !row.included });

  const ready = rows.filter((row) => row.episode !== null);
  const toDownload = ready.filter((row) => row.included);
  const seasonNumbers = target.seasons.length > 0 ? target.seasons.map((season) => season.seasonNumber) : [1];
  const allIncluded = rows.length > 0 && rows.every((row) => row.included);
  const someIncluded = rows.some((row) => row.included);
  const included = rows.filter((row) => row.included);
  const sharedSeason = included.length > 0 && included.every((row) => row.season === included[0].season) ? included[0].season : null;
  const numberedEpisodes = included.flatMap((row) => (row.episode === null ? [] : [row.episode]));
  const firstEpisode = numberedEpisodes.length > 0 ? Math.min(...numberedEpisodes) : null;

  const setAll = (value: boolean) => setRows((current) => current.map((row) => ({ ...row, included: value })));
  const setSeasonForAll = (season: number) =>
    setRows((current) => current.map((row) => (row.included ? { ...row, season } : row)));
  const startFrom = (episode: number) => {
    if (firstEpisode === null || !Number.isFinite(episode) || episode < 1) return;
    const shift = episode - firstEpisode;
    setRows((current) => current.map((row) => (row.included && row.episode !== null ? { ...row, episode: row.episode + shift } : row)));
  };

  return (
    <>
      <p className="dialog__text">{t("addSource.series.check")}</p>
      <div className="mapping-head">
        <label className="mapping-head__all">
          <input
            type="checkbox"
            checked={allIncluded}
            ref={(element) => {
              if (element) element.indeterminate = someIncluded && !allIncluded;
            }}
            onChange={(event) => setAll(event.target.checked)}
          />
          {t("addSource.series.all")}
        </label>
        <div className="mapping-head__bulk">
          <label className="mapping-head__field">
            {t("addSource.series.seasonForAll")}
            <select
              className="select"
              value={sharedSeason ?? ""}
              disabled={included.length === 0}
              onChange={(event) => setSeasonForAll(Number(event.target.value))}
            >
              {sharedSeason === null && <option value="">—</option>}
              {seasonNumbers.map((season) => (
                <option key={season} value={season}>
                  {season === 0 ? t("common.specials") : season}
                </option>
              ))}
            </select>
          </label>
          <label className="mapping-head__field">
            {t("addSource.series.firstEpisode")}
            <input
              className="input input--number"
              type="number"
              min={1}
              value={firstEpisode ?? ""}
              disabled={firstEpisode === null}
              onChange={(event) => startFrom(Number(event.target.value))}
            />
          </label>
        </div>
      </div>
      <p className="mapping-note">{t("addSource.series.online")}</p>
      <div className="file-list">
        {rows.map((row) => (
          <div
            key={row.file.index}
            className={`file-row file-row--pickable ${row.episode !== null ? "is-selected" : ""}`}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("input, select, label")) return;
              toggleRow(row);
            }}
          >
            <input
              type="checkbox"
              checked={row.included}
              aria-label={t("addSource.series.include")}
              onChange={(event) => patchRow(row.file.index, { included: event.target.checked })}
            />
            <span className="file-row__name" title={row.file.path}>
              {baseName(row.file.path)}
            </span>
            <span className="file-row__size">{formatBytes(row.file.length)}</span>
            <label className="file-row__number">
              {t("addSource.series.seasonShort")}
              <select className="select" value={row.season} onChange={(event) => patchRow(row.file.index, { season: Number(event.target.value) })}>
                {seasonNumbers.map((season) => (
                  <option key={season} value={season}>
                    {season === 0 ? t("common.specials") : season}
                  </option>
                ))}
              </select>
            </label>
            <label className="file-row__number">
              {t("addSource.series.episodeShort")}
              <input
                className="input input--number"
                type="number"
                min={1}
                value={row.episode ?? ""}
                placeholder="—"
                onChange={(event) =>
                  patchRow(row.file.index, {
                    episode: event.target.value ? Number(event.target.value) : null,
                    included: Boolean(event.target.value),
                  })
                }
              />
            </label>
          </div>
        ))}
      </div>
      <AddActions
        note={
          ready.length > 0
            ? `${tn("common.episodes", ready.length)} · ${formatBytes(ready.reduce((sum, row) => sum + row.file.length, 0))}`
            : t("addSource.series.hint")
        }
        disabled={ready.length === 0}
        downloadLabel={t("addSource.series.downloadChecked", { count: toDownload.length })}
        downloadDisabled={toDownload.length === 0}
        onAdd={(mode) => onConfirm(ready, mode)}
      />
    </>
  );
}

function AddSourceFlow({ request }: { request: AddSourceRequest }) {
  const close = useUi((state) => state.closeAddSource);
  const toast = useUi((state) => state.toast);
  const { t } = useT();
  const [target, setTarget] = useState<AddSourceTarget | null>(request.target);
  const [preview, setPreview] = useState<TorrentPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const started = useRef(false);
  const cancelled = useRef(false);
  const topic = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef);

  const attemptClose = () => {
    if (!preview || busy) {
      close();
      return;
    }
    useUi.getState().askConfirm({
      title: t("addSource.close.title"),
      message: t("addSource.close.message"),
      confirmLabel: t("addSource.close.confirm"),
      danger: true,
      onConfirm: close,
    });
  };

  const back = () => {
    setError("");
    if (preview && target && !request.target && !chosenFirst.current) {
      setTarget(null);
      return;
    }
    if (preview) {
      topic.current = null;
      setPreview(null);
      return;
    }
    if (target && !request.target) {
      chosenFirst.current = false;
      setTarget(null);
    }
  };
  const chosenFirst = useRef(false);
  const canGoBack = !busy && (preview !== null || (target !== null && !request.target));

  const inspect = async (action: Promise<TorrentPreview>) => {
    setBusy(true);
    setError("");
    try {
      const result = await action;
      if (!cancelled.current) setPreview(result);
    } catch (failure) {
      if (!cancelled.current) setError(describeError(failure));
    } finally {
      if (!cancelled.current) setBusy(false);
    }
  };

  useEffect(() => {
    cancelled.current = false;
    if (!started.current) {
      started.current = true;
      if (request.magnet) void inspect(backend.inspectLink(request.magnet));
      else if (request.filePath) void inspect(backend.inspectFile(request.filePath));
    }
    return () => {
      cancelled.current = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isTopDialog(dialogRef) && !useUi.getState().confirm) attemptClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const commit = async (entries: { unitKey: string; file: TorrentFile; download?: boolean }[], mode: AddMode) => {
    if (!preview || !target) return;
    setBusy(true);
    try {
      const downloadDir = useSettings.getState().downloadDir || null;
      const downloaded = mode === "download" ? entries.filter((entry) => entry.download ?? true).map((entry) => entry.file.index) : [];
      await backend.addTorrent(preview.infoHash, downloaded, downloadDir);
      useLibrary.getState().addSources(entries.map((entry) => ({ unitKey: entry.unitKey, source: toSource(preview, entry.file) })));
      if (target.title.type === "tv" && topic.current) {
        useReleaseWatch
          .getState()
          .follow({
            title: target.title,
            topicId: topic.current,
            infoHash: preview.infoHash,
            defaultSeason: target.defaultSeason,
            ...(target.pinnedSeason !== undefined ? { pinnedSeason: target.pinnedSeason } : {}),
          });
      }
      void useTorrents.getState().refresh();
      close();

      if (mode === "download") {
        toast(t("addSource.toast.downloadStarted", { title: target.title.title }), "success");
      } else if (target.title.type === "movie" && entries.length === 1) {
        useUi.getState().play({ title: target.title, unitKey: entries[0].unitKey });
      } else {
        toast(t("addSource.toast.ready", { title: target.title.title }), "success");
      }
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  };

  const isSeries = target?.title.type === "tv";
  const showsTracker = !preview && target !== null;
  const dialogSize = preview && target ? "dialog--wide" : showsTracker ? "dialog--medium" : "";
  const heading = !preview ? t("common.addTorrent") : target ? target.title.title : t("addSource.whose");

  return (
    <div className="backdrop" onMouseDown={attemptClose}>
      <div
        ref={dialogRef}
        className={`dialog ${dialogSize}`}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog__head">
          {canGoBack && (
            <button className="icon-button dialog__back" aria-label={t("common.back")} title={t("common.back")} onClick={back}>
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="dialog__titles">
            <h2>{heading}</h2>
            {preview && <div className="dialog__sub">{preview.name}</div>}
          </div>
          <button className="icon-button" aria-label={t("common.close")} onClick={attemptClose}>
            <X size={18} />
          </button>
        </div>

        {!preview && (
          <InputStep
            busy={busy}
            error={error}
            target={target}
            suggested={request.suggested ?? null}
            onChooseTitle={(chosen) => {
              chosenFirst.current = true;
              setTarget(chosen);
            }}
            onLink={(link) => {
              topic.current = null;
              void inspect(backend.inspectLink(link));
            }}
            onRelease={(release, topicId, season, single) => {
              topic.current = topicId;
              if (target && target.title.type === "tv") {
                const { pinnedSeason: _previous, ...rest } = target;
                setTarget(season === undefined ? rest : { ...rest, defaultSeason: season, ...(single ? { pinnedSeason: season } : {}) });
              }
              void inspect(release);
            }}
            onFile={(path) => {
              topic.current = null;
              void inspect(backend.inspectFile(path));
            }}
          />
        )}

        {preview && !target && (
          <TitlePicker
            initialQuery={guessTitleQuery(preview.name)}
            guessedSeason={parseEpisode(preview.name).season}
            suggested={request.suggested ?? null}
            question={t("addSource.title.question")}
            onPick={setTarget}
          />
        )}

        {preview && target && error && <p className="add-input__warning">{error}</p>}

        {preview && target && !isSeries && (
          <MovieMapping
            preview={preview}
            onConfirm={(files, mode) => void commit(files.map((file) => ({ unitKey: unitKey("movie", target.title.id), file })), mode)}
          />
        )}

        {preview && target && isSeries && (
          <SeriesMapping
            preview={preview}
            target={target}
            onConfirm={(rows, mode) =>
              void commit(
                rows.map((row) => ({
                  unitKey: unitKey("tv", target.title.id, row.season, row.episode ?? 1),
                  file: row.file,
                  download: row.included,
                })),
                mode,
              )
            }
          />
        )}

        {busy && preview && (
          <div className="dialog__busy">
            <LoaderCircle size={28} className="spin" />
          </div>
        )}
      </div>
    </div>
  );
}

export function AddSourceDialog() {
  const request = useUi((state) => state.addSource);
  if (!request) return null;
  return <AddSourceFlow key={`${request.magnet ?? ""}|${request.filePath ?? ""}|${request.target?.title.id ?? ""}`} request={request} />;
}
