import { useEffect, useMemo, useRef, useState } from "react";
import { Download, FileUp, Link2, LoaderCircle, Play, Search, X } from "lucide-react";
import { backend, describeError, isDesktop, type TorrentFile, type TorrentPreview } from "../lib/backend";
import { formatBytes } from "../lib/format";
import { useT } from "../lib/i18n";
import { baseName, guessTitleQuery, isMagnetLink, isVideoFile, parseEpisode, parseQuality, resolveEpisode } from "../lib/parse";
import { toSource } from "../lib/releaseUpdate";
import { imageUrl, tmdb, type MediaItem, type SeasonInfo } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
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
  onLink,
  onRelease,
  onFile,
}: {
  busy: boolean;
  error: string;
  target: AddSourceTarget | null;
  onLink: (link: string) => void;
  onRelease: (release: Promise<TorrentPreview>, topicId: string) => void;
  onFile: (path: string) => void;
}) {
  const [value, setValue] = useState("");
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
      {error && <p className="add-input__warning">{error}</p>}
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
      {target && <TrackerSearch target={target} onPick={onRelease} />}
    </div>
  );
}

function TitlePicker({
  preview,
  suggested,
  onPick,
}: {
  preview: TorrentPreview;
  suggested: AddSourceTarget | null;
  onPick: (target: AddSourceTarget) => void;
}) {
  const [query, setQuery] = useState(() => guessTitleQuery(preview.name));
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
      const guessed = parseEpisode(preview.name).season;
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
      <p className="dialog__text">{t("addSource.title.question")}</p>
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

function buildEpisodeRows(preview: TorrentPreview, seasons: SeasonInfo[], defaultSeason: number): EpisodeRowState[] {
  return videoFiles(preview).map((file) => {
    const slot = resolveEpisode(parseEpisode(file.path), seasons, defaultSeason);
    return { file, included: slot !== null, season: slot?.season ?? defaultSeason, episode: slot?.episode ?? null };
  });
}

type AddMode = "stream" | "download";

function AddActions({ note, disabled, onAdd }: { note?: string; disabled: boolean; onAdd: (mode: AddMode) => void }) {
  const { t } = useT();
  return (
    <>
      <div className="dialog__actions">
        {note && <span className="dialog__note">{note}</span>}
        <button className="button" disabled={disabled} onClick={() => onAdd("download")}>
          <Download size={16} />
          {t("common.download")}
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
  const [defaultSeason, setDefaultSeason] = useState(target.defaultSeason);
  const [rows, setRows] = useState(() => buildEpisodeRows(preview, target.seasons, target.defaultSeason));
  const { t, tn } = useT();

  const changeDefaultSeason = (season: number) => {
    setDefaultSeason(season);
    setRows(buildEpisodeRows(preview, target.seasons, season));
  };
  const patchRow = (index: number, change: Partial<EpisodeRowState>) =>
    setRows((current) => current.map((row) => (row.file.index === index ? { ...row, ...change } : row)));

  const ready = rows.filter((row) => row.included && row.episode !== null);
  const seasonNumbers = target.seasons.length > 0 ? target.seasons.map((season) => season.seasonNumber) : [1];

  return (
    <>
      <div className="mapping-head">
        <p className="dialog__text">{t("addSource.series.check")}</p>
        <label className="mapping-head__season">
          {t("addSource.series.defaultSeason")}
          <select className="select" value={defaultSeason} onChange={(event) => changeDefaultSeason(Number(event.target.value))}>
            {seasonNumbers.map((season) => (
              <option key={season} value={season}>
                {season === 0 ? t("common.specials") : season}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="file-list">
        {rows.map((row) => (
          <div key={row.file.index} className={`file-row ${row.included && row.episode !== null ? "is-selected" : ""}`}>
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
                    {season}
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
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const commit = async (entries: { unitKey: string; file: TorrentFile }[], mode: AddMode) => {
    if (!preview || !target) return;
    setBusy(true);
    try {
      const downloadDir = useSettings.getState().downloadDir || null;
      const downloaded = mode === "download" ? entries.map((entry) => entry.file.index) : [];
      await backend.addTorrent(preview.infoHash, downloaded, downloadDir);
      useLibrary.getState().addSources(entries.map((entry) => ({ unitKey: entry.unitKey, source: toSource(preview, entry.file) })));
      if (target.title.type === "tv" && topic.current) {
        useReleaseWatch
          .getState()
          .follow({ title: target.title, topicId: topic.current, infoHash: preview.infoHash, defaultSeason: target.defaultSeason });
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
    <div className="backdrop" onMouseDown={close}>
      <div className={`dialog ${dialogSize}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <div>
            <h2>{heading}</h2>
            {preview && <div className="dialog__sub">{preview.name}</div>}
          </div>
          <button className="icon-button" aria-label={t("common.close")} onClick={close}>
            <X size={18} />
          </button>
        </div>

        {!preview && (
          <InputStep
            busy={busy}
            error={error}
            target={target}
            onLink={(link) => {
              topic.current = null;
              void inspect(backend.inspectLink(link));
            }}
            onRelease={(release, topicId) => {
              topic.current = topicId;
              void inspect(release);
            }}
            onFile={(path) => {
              topic.current = null;
              void inspect(backend.inspectFile(path));
            }}
          />
        )}

        {preview && !target && <TitlePicker preview={preview} suggested={request.suggested ?? null} onPick={setTarget} />}

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
