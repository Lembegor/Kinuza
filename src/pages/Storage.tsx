import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Clapperboard, Eye, FolderOpen, HardDrive, LoaderCircle, ShieldCheck, Sparkles, Trash2, TriangleAlert, Zap } from "lucide-react";
import { StorageBar, downloadedBytes, useStorageReport, useStorageTotals } from "../components/StorageBar";
import { backend, describeError, isDesktop, type CacheEntry, type StoragePart, type TorrentView } from "../lib/backend";
import { formatBytes } from "../lib/format";
import { useT } from "../lib/i18n";
import { isWatched, useLibrary } from "../state/library";
import { useSettings } from "../state/settings";
import { useTorrentTitles, type TorrentTitle } from "../state/torrentTitles";
import { isDownload, useTorrents } from "../state/torrents";
import { useUi } from "../state/ui";

const junkParts: StoragePart["id"][] = ["logs", "webCache", "mpv"];
const dayMs = 24 * 60 * 60 * 1000;

interface DownloadEntry {
  torrent: TorrentView;
  bytes: number;
  title: TorrentTitle | undefined;
  watched: number;
  units: number;
}

async function openFolder(path: string): Promise<void> {
  if (!isDesktop || !path) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

function Busy({ on }: { on: boolean }) {
  return on ? <LoaderCircle size={15} className="spin" /> : null;
}

export default function Storage() {
  const { t, tn } = useT();
  const navigate = useNavigate();
  const toast = useUi((state) => state.toast);
  const askConfirm = useUi((state) => state.askConfirm);
  const settings = useSettings();
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const report = useStorageReport(version);
  const totals = useStorageTotals(report.data);
  const torrents = useTorrents((state) => state.list);
  const titles = useTorrentTitles();
  const progress = useLibrary((state) => state.progress);

  const downloads = useMemo<DownloadEntry[]>(
    () =>
      torrents
        .filter(isDownload)
        .map((torrent) => {
          const title = titles[torrent.infoHash];
          const units = title?.units ?? [];
          return { torrent, bytes: downloadedBytes(torrent), title, units: units.length, watched: units.filter((unit) => isWatched(progress[unit])).length };
        })
        .filter((entry) => entry.bytes > 0)
        .sort((a, b) => b.bytes - a.bytes),
    [torrents, titles, progress],
  );
  const watchedDownloads = downloads.filter((entry) => entry.units > 0 && entry.watched === entry.units);
  const cache = useMemo(() => [...(report.data?.cache ?? [])].sort((a, b) => b.bytes - a.bytes), [report.data]);
  const parts = report.data?.parts ?? [];
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const cacheBytes = sum(cache.map((item) => item.bytes));
  const junkBytes = cacheBytes + sum(parts.filter((part) => part.clearable && junkParts.includes(part.id)).map((part) => part.bytes));

  const refresh = async () => {
    setVersion((value) => value + 1);
    await useTorrents.getState().refresh();
  };

  const act = async (key: string, work: () => Promise<number>, done?: string) => {
    setBusy(key);
    try {
      const freed = await work();
      toast(done ?? (freed > 0 ? t("storage.freed", { size: formatBytes(freed) }) : t("storage.nothing")), "success");
    } catch (error) {
      toast(describeError(error), "error");
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const confirm = (title: string, message: string, confirmLabel: string, run: () => void, danger = true) =>
    askConfirm({ title, message, confirmLabel, danger, onConfirm: run });

  const freeMany = (entries: DownloadEntry[]) => async () => {
    let freed = 0;
    for (const entry of entries) freed += await backend.freeDownload(entry.torrent.infoHash);
    return freed;
  };

  const clearJunk = () =>
    confirm(t("storage.junk.title"), t("storage.junk.message", { size: formatBytes(junkBytes) }), t("storage.junk.confirm"), () =>
      void act("junk", async () => {
        let freed = await backend.clearStreamCache();
        for (const part of parts.filter((item) => item.clearable && junkParts.includes(item.id))) freed += await backend.clearStoragePart(part.id);
        return freed;
      }),
    false,
    );

  const titleOf = (entry: { infoHash: string; name: string }) => titles[entry.infoHash];
  const daysAgo = (time: number) => (time > 0 ? Math.max(0, Math.floor((Date.now() - time) / dayMs)) : null);

  return (
    <div className="page page--narrow storage-page">
      <div className="page__head">
        <button className="icon-button" aria-label={t("common.back")} onClick={() => navigate(-1)}>
          <ArrowLeft size={18} />
        </button>
        <h1>{t("storage.title")}</h1>
      </div>

      <section className="storage-summary">
        {totals ? <StorageBar totals={totals} large /> : <p className="storage-note">{t("storage.loading")}</p>}
        {totals?.lowSpace && (
          <p className="storage-warning">
            <TriangleAlert size={16} />
            {t("storage.low", { free: formatBytes(totals.free) })}
          </p>
        )}
        <div className="storage-summary__foot">
          <p className="storage-safe">
            <ShieldCheck size={16} />
            {t("storage.safe")}
          </p>
          <button className="button button--primary" disabled={junkBytes === 0 || busy !== null} onClick={clearJunk}>
            {busy === "junk" ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}
            {t("storage.junk.button", { size: formatBytes(junkBytes) })}
          </button>
        </div>
      </section>

      <section className="settings-group storage-group">
        <div className="storage-group__head">
          <div>
            <h2>
              <HardDrive size={18} />
              {t("storage.downloads.title")}
              <span>{formatBytes(sum(downloads.map((entry) => entry.bytes)))}</span>
            </h2>
            <p>{t("storage.downloads.note")}</p>
          </div>
          <div className="storage-group__actions">
            {watchedDownloads.length > 0 && (
              <button
                className="button"
                disabled={busy !== null}
                onClick={() =>
                  confirm(
                    t("storage.downloads.watched.title"),
                    t("storage.downloads.watched.message", { count: watchedDownloads.length, size: formatBytes(sum(watchedDownloads.map((entry) => entry.bytes))) }),
                    t("storage.free"),
                    () => void act("watched", freeMany(watchedDownloads)),
                  )
                }
              >
                <Eye size={16} />
                {t("storage.downloads.watched.button", { size: formatBytes(sum(watchedDownloads.map((entry) => entry.bytes))) })}
              </button>
            )}
            {downloads.length > 0 && (
              <button
                className="button button--danger"
                disabled={busy !== null}
                onClick={() =>
                  confirm(
                    t("storage.downloads.all.title"),
                    t("storage.downloads.all.message", { size: formatBytes(sum(downloads.map((entry) => entry.bytes))) }),
                    t("storage.free"),
                    () => void act("downloads", freeMany(downloads)),
                  )
                }
              >
                <Trash2 size={16} />
                {t("storage.downloads.all.button")}
              </button>
            )}
          </div>
        </div>
        {downloads.length === 0 ? (
          <p className="storage-empty">{t("storage.downloads.empty")}</p>
        ) : (
          downloads.map((entry) => (
            <div key={entry.torrent.infoHash} className="storage-item">
              <Clapperboard size={18} className="storage-item__icon" />
              <div className="storage-item__body">
                {entry.title ? <Link to={entry.title.path}>{entry.title.label}</Link> : <strong>{entry.torrent.name}</strong>}
                <span>
                  {entry.title ? `${entry.torrent.name} · ` : ""}
                  {!entry.torrent.finished && t("storage.downloads.partial")}
                </span>
                {entry.units > 0 && (
                  <em className={`storage-tag ${entry.watched === entry.units ? "is-done" : ""}`}>
                    {entry.watched === entry.units
                      ? t("storage.downloads.allWatched")
                      : entry.units > 1
                        ? t("storage.downloads.someWatched", { watched: entry.watched, total: entry.units })
                        : t("storage.downloads.notWatched")}
                  </em>
                )}
              </div>
              <strong className="storage-item__size">{formatBytes(entry.bytes)}</strong>
              <button className="icon-button" aria-label={t("downloads.openFolder")} title={t("downloads.openFolder")} onClick={() => void openFolder(entry.torrent.outputFolder)}>
                <FolderOpen size={16} />
              </button>
              <button
                className="button button--small"
                disabled={busy !== null}
                onClick={() =>
                  confirm(t("storage.download.title"), t("storage.download.message", { name: entry.title?.label ?? entry.torrent.name, size: formatBytes(entry.bytes) }), t("storage.free"), () =>
                    void act(entry.torrent.infoHash, () => backend.freeDownload(entry.torrent.infoHash)),
                  )
                }
              >
                <Busy on={busy === entry.torrent.infoHash} />
                {t("storage.free")}
              </button>
            </div>
          ))
        )}
      </section>

      <section className="settings-group storage-group">
        <div className="storage-group__head">
          <div>
            <h2>
              <Zap size={18} />
              {t("storage.cache.title")}
              <span>{formatBytes(cacheBytes)}</span>
            </h2>
            <p>{t("storage.cache.note")}</p>
          </div>
          <div className="storage-group__actions">
            <label className="storage-limit">
              {t("storage.cache.limit")}
              <input
                className="input input--number"
                type="number"
                min={0}
                step={5}
                value={settings.cacheLimitGb}
                onChange={(event) => settings.patch({ cacheLimitGb: Math.max(0, Number(event.target.value) || 0) })}
              />
              {t("settings.cache.unit")}
            </label>
            {cache.length > 0 && (
              <button
                className="button"
                disabled={busy !== null}
                onClick={() =>
                  confirm(t("storage.cache.all.title"), t("storage.cache.all.message", { size: formatBytes(cacheBytes) }), t("storage.clear"), () =>
                    void act("cache", () => backend.clearStreamCache()),
                  false,
                  )
                }
              >
                <Busy on={busy === "cache"} />
                {t("storage.cache.all.button")}
              </button>
            )}
          </div>
        </div>
        {cache.length === 0 ? (
          <p className="storage-empty">{t("storage.cache.empty")}</p>
        ) : (
          cache.map((item: CacheEntry) => {
            const title = titleOf(item);
            const days = daysAgo(item.lastPlayed);
            return (
              <div key={item.infoHash} className="storage-item">
                <Zap size={18} className="storage-item__icon" />
                <div className="storage-item__body">
                  {title ? <Link to={title.path}>{title.label}</Link> : <strong>{item.name}</strong>}
                  <span>
                    {title ? `${item.name} · ` : ""}
                    {days === null ? "" : days === 0 ? t("storage.cache.today") : tn("storage.cache.daysAgo", days)}
                  </span>
                  {item.inUse && <em className="storage-tag">{t("storage.cache.inUse")}</em>}
                </div>
                <strong className="storage-item__size">{formatBytes(item.bytes)}</strong>
                <button className="button button--small" disabled={busy !== null || item.inUse} onClick={() => void act(item.infoHash, () => backend.dropCached(item.infoHash))}>
                  <Busy on={busy === item.infoHash} />
                  {t("storage.clear")}
                </button>
              </div>
            );
          })
        )}
      </section>

      <section className="settings-group storage-group">
        <div className="storage-group__head">
          <div>
            <h2>
              <Sparkles size={18} />
              {t("storage.app.title")}
              <span>{formatBytes(sum(parts.map((part) => part.bytes)))}</span>
            </h2>
            <p>{t("storage.app.note")}</p>
          </div>
        </div>
        {parts.map((part) => (
          <div key={part.id} className="storage-item">
            {part.clearable ? <Sparkles size={18} className="storage-item__icon" /> : <ShieldCheck size={18} className="storage-item__icon storage-item__icon--safe" />}
            <div className="storage-item__body">
              <strong>{t(`storage.part.${part.id}`)}</strong>
              <span>{t(`storage.part.${part.id}.note`)}</span>
              {part.id === "webCache" && report.data?.webCachePending && <em className="storage-tag">{t("storage.part.webCache.pending")}</em>}
            </div>
            <strong className="storage-item__size">{formatBytes(part.bytes)}</strong>
            {part.clearable ? (
              <button
                className="button button--small"
                disabled={busy !== null || (part.id === "webCache" && report.data?.webCachePending)}
                onClick={() =>
                  void act(part.id, () => backend.clearStoragePart(part.id), part.later ? t("storage.part.later") : undefined)
                }
              >
                <Busy on={busy === part.id} />
                {t("storage.clear")}
              </button>
            ) : (
              <em className="storage-tag storage-tag--safe">{t("storage.kept")}</em>
            )}
          </div>
        ))}
        {totals && report.data?.dataDisk && (
          <p className="storage-path">
            {t("storage.where", { path: report.data.dataDisk.path })}{" "}
            <button className="link-button" onClick={() => void openFolder(report.data!.dataDisk!.path)}>
              {t("downloads.openFolder")}
            </button>
          </p>
        )}
      </section>
    </div>
  );
}
