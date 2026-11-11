import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, Download, FolderOpen, Pause, Play, Plus, Trash2, Users } from "lucide-react";
import { EmptyState } from "../components/Cards";
import { backend, describeError, isDesktop, type TorrentView } from "../lib/backend";
import { formatBytes, formatEta, formatSpeed } from "../lib/format";
import { t, useT, type MessageKey } from "../lib/i18n";
import { useLibrary, type Progress, type Source } from "../state/library";
import { etaSeconds, torrentProgress, useTorrents } from "../state/torrents";
import { useUi } from "../state/ui";

const stateLabels: Record<string, MessageKey> = {
  initializing: "downloads.state.initializing",
  paused: "downloads.state.paused",
  queued: "status.queued",
  error: "downloads.state.error",
};

/** Nothing in the torrent is being saved: it is only watched online. */
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

/** Maps info hashes to the title they were attached to, using saved sources and watch history. */
function useTorrentTitles(): Record<string, { path: string; label: string }> {
  const sources = useLibrary((state) => state.sources);
  const tracked = useLibrary((state) => state.tracked);
  const progress = useLibrary((state) => state.progress);
  const { t } = useT();

  return useMemo(() => {
    const names = new Map<string, string>();
    for (const [key, title] of Object.entries(tracked)) names.set(key, title.title);
    for (const item of Object.values<Progress>(progress)) names.set(`${item.title.type}:${item.title.id}`, item.title.title);

    const result: Record<string, { path: string; label: string }> = {};
    for (const [unit, list] of Object.entries<Source[]>(sources)) {
      const [type, id] = unit.split(":");
      for (const source of list) {
        result[source.infoHash] ??= {
          path: `/title/${type}/${id}`,
          label: names.get(`${type}:${id}`) ?? t("common.openPage"),
        };
      }
    }
    return result;
  }, [sources, tracked, progress]);
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

function TorrentCard({ torrent, link }: { torrent: TorrentView; link?: { path: string; label: string } }) {
  const askConfirm = useUi((state) => state.askConfirm);
  const removeFromLibrary = useLibrary((state) => state.removeTorrent);
  const { t } = useT();
  const progress = torrentProgress(torrent);
  const paused = torrent.state === "paused";

  const remove = () =>
    askConfirm({
      title: t("downloads.remove.title"),
      message: torrent.name,
      confirmLabel: t("common.delete"),
      optionLabel: t("downloads.remove.files"),
      danger: true,
      onConfirm: (deleteFiles) => {
        removeFromLibrary(torrent.infoHash);
        void run(backend.remove(torrent.infoHash, deleteFiles));
      },
    });

  return (
    <div className={`torrent ${torrent.finished ? "is-finished" : ""}`}>
      <div className="torrent__main">
        <div className="torrent__name">{torrent.name}</div>
        <div className="torrent__meta">
          {link && (
            <Link to={link.path} className="torrent__link">
              {link.label}
            </Link>
          )}
          <span>{statusText(torrent)}</span>
          <span>
            {isOnlineOnly(torrent)
              ? t("downloads.onDisk", { size: formatBytes(torrent.files.reduce((sum, file) => sum + file.downloaded, 0)) })
              : t("downloads.progress", { done: formatBytes(torrent.progressBytes), total: formatBytes(torrent.totalBytes) })}
          </span>
          {torrent.state === "live" && (
            <>
              <span className="torrent__stat">
                <ArrowDown size={13} />
                {formatSpeed(torrent.downloadSpeed)}
              </span>
              <span className="torrent__stat">
                <ArrowUp size={13} />
                {formatSpeed(torrent.uploadSpeed)}
              </span>
              <span className="torrent__stat">
                <Users size={13} />
                {torrent.peers}
              </span>
            </>
          )}
        </div>
        {torrent.error && <div className="torrent__error">{torrent.error}</div>}
        <div className="bar">
          <i style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
      <div className="torrent__percent">{Math.floor(progress * 100)}%</div>
      <div className="torrent__actions">
        <button
          className="icon-button"
          aria-label={paused ? t("downloads.resume") : t("downloads.pause")}
          onClick={() => void run(paused ? backend.resume(torrent.infoHash) : backend.pause(torrent.infoHash))}
        >
          {paused ? <Play size={17} /> : <Pause size={17} />}
        </button>
        <button className="icon-button" aria-label={t("downloads.openFolder")} onClick={() => void openFolder(torrent.outputFolder)}>
          <FolderOpen size={17} />
        </button>
        <button className="icon-button" aria-label={t("common.delete")} onClick={remove}>
          <Trash2 size={17} />
        </button>
      </div>
    </div>
  );
}

export default function Downloads() {
  const everything = useTorrents((state) => state.list);
  // Torrents parked between online viewings hold nothing on disk and are not downloads.
  const torrents = useMemo(() => everything.filter((torrent) => torrent.state !== "parked"), [everything]);
  const openAddSource = useUi((state) => state.openAddSource);
  const titles = useTorrentTitles();
  const { t } = useT();

  const totals = useMemo(
    () => ({
      down: torrents.reduce((sum, torrent) => sum + torrent.downloadSpeed, 0),
      up: torrents.reduce((sum, torrent) => sum + torrent.uploadSpeed, 0),
    }),
    [torrents],
  );
  const sorted = useMemo(
    () => [...torrents].sort((a, b) => Number(a.finished) - Number(b.finished) || a.name.localeCompare(b.name)),
    [torrents],
  );

  return (
    <div className="page">
      <div className="page__head">
        <h1>{t("downloads.title")}</h1>
        {torrents.length > 0 && (
          <span className="section__note">
            ↓ {formatSpeed(totals.down)} · ↑ {formatSpeed(totals.up)}
          </span>
        )}
        <button className="button button--primary" onClick={() => openAddSource({ target: null })}>
          <Plus size={16} />
          {t("common.addTorrent")}
        </button>
      </div>
      {sorted.length === 0 ? (
        <EmptyState
          icon={<Download size={40} />}
          title={t("downloads.empty.title")}
          text={t("downloads.empty.text")}
        />
      ) : (
        <div className="torrent-list">
          {sorted.map((torrent) => (
            <TorrentCard key={torrent.infoHash} torrent={torrent} link={titles[torrent.infoHash]} />
          ))}
        </div>
      )}
    </div>
  );
}
