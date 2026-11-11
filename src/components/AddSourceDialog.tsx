// Adds a torrent: magnet link or .torrent file -> file list -> which movie or episodes the files are.

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, FileUp, Landmark, Link2, LoaderCircle, Search, X } from "lucide-react";
import { rutracker, type RutrackerItem } from "../lib/rutracker";
import { backend, describeError, isDesktop, type TorrentFile, type TorrentPreview } from "../lib/backend";
import { formatBytes, plural } from "../lib/format";
import { baseName, guessTitleQuery, isMagnetLink, isVideoFile, parseEpisode, parseQuality, parseTags, resolveEpisode } from "../lib/parse";
import { imageUrl, tmdb, type MediaItem, type SeasonInfo } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { toTitleRef, unitKey, useLibrary, type Source } from "../state/library";
import { useSettings } from "../state/settings";
import { useTorrents } from "../state/torrents";
import { useUi, type AddSourceRequest, type AddSourceTarget } from "../state/ui";
import { typeLabel } from "./Cards";

const titleSearchDebounceMs = 350;
const titleSearchLimit = 8;
const playerFriendlyExtensions = /\.(mp4|m4v|mkv|webm|mov)$/i;

function toSource(preview: TorrentPreview, file: TorrentFile): Source {
  const name = baseName(file.path);
  return {
    id: `${preview.infoHash}:${file.index}`,
    infoHash: preview.infoHash,
    fileIndex: file.index,
    fileName: name,
    size: file.length,
    quality: parseQuality(name) || parseQuality(preview.name),
    tags: parseTags(`${preview.name} ${name}`),
    torrentName: preview.name,
    addedAt: Date.now(),
  };
}

function videoFiles(preview: TorrentPreview): TorrentFile[] {
  const videos = preview.files.filter((file) => isVideoFile(file.path));
  return (videos.length > 0 ? videos : preview.files).sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { numeric: true }),
  );
}

async function openPage(url: string): Promise<void> {
  if (!isDesktop) {
    window.open(url, "_blank");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

function RutrackerResults({ target, onPick }: { target: AddSourceTarget; onPick: (magnet: string) => void }) {
  const query = `${target.originalTitle || target.title.title} ${target.title.year || ""}`.trim();
  
  const [items, setItems] = useState<RutrackerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const fetchResults = async () => {
    setLoading(true);
    setError(null);
    setNeedsAuth(false);
    try {
      const data = await rutracker.search(query);
      setItems(data);
    } catch (err) {
      if (err === "auth_required") setNeedsAuth(true);
      else setError("Не удалось выполнить поиск на RuTracker.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchResults();
  }, [query]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !pass) return;
    setAuthBusy(true);
    try {
      await rutracker.login(user, pass);
      await fetchResults();
    } catch (err) {
      useUi.getState().toast("Неверный логин или пароль", "error");
    } finally {
      setAuthBusy(false);
    }
  };

  const pickItem = async (item: RutrackerItem) => {
    setResolvingId(item.id);
    try {
      const magnet = await rutracker.getMagnet(item.id);
      onPick(magnet);
    } catch (err) {
      useUi.getState().toast("Не удалось получить magnet-ссылку", "error");
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <div className="archive">
      <div className="archive__head">
        <Search size={16} />
        <strong>Поиск раздач</strong>
        <span>RuTracker.org</span>
      </div>

      {needsAuth ? (
        <form className="archive__auth" onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "10px" }}>
          <p className="archive__note">Для поиска требуется вход в аккаунт RuTracker.</p>
          <input className="input" autoFocus placeholder="Логин" value={user} onChange={(e) => setUser(e.target.value)} />
          <input className="input" type="password" placeholder="Пароль" value={pass} onChange={(e) => setPass(e.target.value)} />
          <button type="submit" className="button button--primary" disabled={authBusy}>
            {authBusy ? <LoaderCircle size={16} className="spin" /> : "Войти"}
          </button>
        </form>
      ) : loading ? (
        <p className="archive__note">Ищем «{query}»…</p>
      ) : error ? (
        <p className="archive__note">{error}</p>
      ) : items.length === 0 ? (
        <p className="archive__note">По запросу «{query}» на трекере ничего не найдено.</p>
      ) : (
        items.map((item) => (
          <div key={item.id} className="archive__item" style={{ alignItems: "center" }}>
            <div className="archive__title">
              <strong style={{ fontSize: "0.9em", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {item.title}
              </strong>
              <span>
                {item.size} · Сиды: <strong style={{ color: "var(--color-success)" }}>{item.seeds}</strong>
              </span>
            </div>
            <button className="icon-button" aria-label="Страница раздачи" title="Страница раздачи" onClick={() => void openPage(item.pageUrl)}>
              <ExternalLink size={15} />
            </button>
            <button className="button button--small" disabled={resolvingId !== null} onClick={() => void pickItem(item)}>
              {resolvingId === item.id ? <LoaderCircle size={15} className="spin" /> : "Выбрать"}
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function InputStep({
  busy,
  error,
  target,
  onLink,
  onFile,
}: {
  busy: boolean;
  error: string;
  target: AddSourceTarget | null;
  onLink: (link: string) => void;
  onFile: (path: string) => void;
}) {
  const [value, setValue] = useState("");
  const valid = isMagnetLink(value);

  const pickFile = async () => {
    if (!isDesktop) {
      onFile("demo.torrent");
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ title: "Выберите .torrent-файл", filters: [{ name: "Torrent", extensions: ["torrent"] }] });
    if (typeof picked === "string") onFile(picked);
  };

  if (busy) {
    return (
      <div className="add-loading">
        <LoaderCircle size={34} className="spin" />
        <strong>Получаем список файлов</strong>
        <p>Для magnet-ссылки это занимает от пары секунд до минуты: нужно найти участников раздачи.</p>
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
          placeholder="Вставьте magnet-ссылку"
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
      {value && !valid && <p className="add-input__warning">Это не похоже на magnet-ссылку. Она начинается с «magnet:?xt=urn:btih:».</p>}
      {error && <p className="add-input__warning">{error}</p>}
      <div className="add-input__actions">
        <button className="button" onClick={() => void pickFile()}>
          <FileUp size={16} />
          Выбрать .torrent-файл
        </button>
        <button className="button button--primary" disabled={!valid} onClick={() => onLink(value.trim())}>
          Продолжить
        </button>
      </div>
      <p className="add-input__hint">Файл .torrent можно просто перетащить в окно приложения.</p>
      {target?.title.type === "movie" && <RutrackerResults target={target} onPick={(magnet) => onLink(magnet)} />}
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
      onPick({ title: toTitleRef(item), originalTitle: item.originalTitle, seasons, defaultSeason: guessed ?? firstRegular });
    } catch (error) {
      useUi.getState().toast(describeError(error), "error");
      setResolving(null);
    }
  };

  return (
    <div className="title-picker">
      <p className="dialog__text">К какому фильму или сериалу относится этот торрент?</p>
      <label className="add-input__field">
        <Search size={18} />
        <input autoFocus value={query} placeholder="Название" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="title-picker__list">
        {suggested && (
          <button className="title-picker__item title-picker__item--suggested" disabled={resolving !== null} onClick={() => onPick(suggested)}>
            <img src={imageUrl(suggested.title.poster, "w185") ?? undefined} alt="" />
            <div>
              <strong>{suggested.title.title}</strong>
              <span>Открыто сейчас в приложении</span>
            </div>
          </button>
        )}
        {results.loading && <div className="title-picker__empty">Ищем…</div>}
        {!results.loading && (results.data ?? []).length === 0 && (
          <div className="title-picker__empty">{debounced ? "Ничего не нашлось — поправьте название." : "Введите название."}</div>
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

function MovieMapping({ preview, onConfirm }: { preview: TorrentPreview; onConfirm: (files: TorrentFile[]) => void }) {
  const files = useMemo(() => videoFiles(preview), [preview]);
  const preferred = useMemo(() => {
    const friendly = files.filter((file) => playerFriendlyExtensions.test(file.path));
    const pool = friendly.length > 0 ? friendly : files;
    return pool.reduce((best, file) => (file.length > best.length ? file : best), pool[0]);
  }, [files]);
  const [selected, setSelected] = useState(preferred?.index ?? 0);

  return (
    <>
      <p className="dialog__text">Выберите файл с фильмом.</p>
      <div className="file-list">
        {files.map((file) => (
          <label key={file.index} className={`file-row ${selected === file.index ? "is-selected" : ""}`}>
            <input type="radio" name="movie-file" checked={selected === file.index} onChange={() => setSelected(file.index)} />
            <span className="file-row__name" title={file.path}>
              {baseName(file.path)}
            </span>
            <span className="quality-tag">{parseQuality(file.path) || parseQuality(preview.name) || "видео"}</span>
            <span className="file-row__size">{formatBytes(file.length)}</span>
          </label>
        ))}
      </div>
      <div className="dialog__actions">
        <button className="button button--primary" disabled={files.length === 0} onClick={() => onConfirm(files.filter((file) => file.index === selected))}>
          Добавить и скачать
        </button>
      </div>
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
  onConfirm: (rows: EpisodeRowState[]) => void;
}) {
  const [defaultSeason, setDefaultSeason] = useState(target.defaultSeason);
  const [rows, setRows] = useState(() => buildEpisodeRows(preview, target.seasons, target.defaultSeason));

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
        <p className="dialog__text">Проверьте, какой серии соответствует каждый файл.</p>
        <label className="mapping-head__season">
          Сезон по умолчанию
          <select className="select" value={defaultSeason} onChange={(event) => changeDefaultSeason(Number(event.target.value))}>
            {seasonNumbers.map((season) => (
              <option key={season} value={season}>
                {season === 0 ? "Спецвыпуски" : season}
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
              aria-label="Скачивать файл"
              onChange={(event) => patchRow(row.file.index, { included: event.target.checked })}
            />
            <span className="file-row__name" title={row.file.path}>
              {baseName(row.file.path)}
            </span>
            <span className="file-row__size">{formatBytes(row.file.length)}</span>
            <label className="file-row__number">
              С
              <select className="select" value={row.season} onChange={(event) => patchRow(row.file.index, { season: Number(event.target.value) })}>
                {seasonNumbers.map((season) => (
                  <option key={season} value={season}>
                    {season}
                  </option>
                ))}
              </select>
            </label>
            <label className="file-row__number">
              Э
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
      <div className="dialog__actions">
        <span className="dialog__note">
          {ready.length > 0
            ? `${ready.length} ${plural(ready.length, "серия", "серии", "серий")} · ${formatBytes(ready.reduce((sum, row) => sum + row.file.length, 0))}`
            : "Отметьте файлы и укажите номера серий"}
        </span>
        <button className="button button--primary" disabled={ready.length === 0} onClick={() => onConfirm(ready)}>
          Добавить и скачать
        </button>
      </div>
    </>
  );
}

function AddSourceFlow({ request }: { request: AddSourceRequest }) {
  const close = useUi((state) => state.closeAddSource);
  const toast = useUi((state) => state.toast);
  const [target, setTarget] = useState<AddSourceTarget | null>(request.target);
  const [preview, setPreview] = useState<TorrentPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const started = useRef(false);
  const cancelled = useRef(false);

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

  const commit = async (entries: { unitKey: string; file: TorrentFile }[]) => {
    if (!preview || !target) return;
    setBusy(true);
    try {
      const downloadDir = useSettings.getState().downloadDir || null;
      await backend.addTorrent(preview.infoHash, entries.map((entry) => entry.file.index), downloadDir);
      useLibrary.getState().addSources(entries.map((entry) => ({ unitKey: entry.unitKey, source: toSource(preview, entry.file) })));
      void useTorrents.getState().refresh();
      toast(`«${target.title.title}»: загрузка началась`, "success");
      close();
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  };

  const isSeries = target?.title.type === "tv";
  const heading = !preview ? "Добавить торрент" : target ? target.title.title : "Чей это торрент?";

  return (
    <div className="backdrop" onMouseDown={close}>
      <div className={`dialog ${preview && target ? "dialog--wide" : ""}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <div>
            <h2>{heading}</h2>
            {preview && <div className="dialog__sub">{preview.name}</div>}
          </div>
          <button className="icon-button" aria-label="Закрыть" onClick={close}>
            <X size={18} />
          </button>
        </div>

        {!preview && (
          <InputStep
            busy={busy}
            error={error}
            target={target}
            onLink={(link) => void inspect(backend.inspectLink(link))}
            onFile={(path) => void inspect(backend.inspectFile(path))}
          />
        )}

        {preview && !target && <TitlePicker preview={preview} suggested={request.suggested ?? null} onPick={setTarget} />}

        {preview && target && error && <p className="add-input__warning">{error}</p>}

        {preview && target && !isSeries && (
          <MovieMapping
            preview={preview}
            onConfirm={(files) => void commit(files.map((file) => ({ unitKey: unitKey("movie", target.title.id), file })))}
          />
        )}

        {preview && target && isSeries && (
          <SeriesMapping
            preview={preview}
            target={target}
            onConfirm={(rows) =>
              void commit(
                rows.map((row) => ({
                  unitKey: unitKey("tv", target.title.id, row.season, row.episode ?? 1),
                  file: row.file,
                })),
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
