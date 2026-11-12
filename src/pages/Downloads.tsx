import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, Download, FolderOpen, Pause, Play, Plus, Trash2, Users } from "lucide-react";
import { EmptyState } from "../components/Cards";
import { backend, describeError, isDesktop, type TorrentView } from "../lib/backend";
import { formatBytes, formatEta, formatSpeed } from "../lib/format";
import { t, useT, type MessageKey } from "../lib/i18n";
import { useLibrary } from "../state/library";
import { etaSeconds, isDownload, torrentProgress, useTorrents } from "../state/torrents";
import { useUi } from "../state/ui";
import { useTorrentTitles, type TorrentTitle } from "../state/torrentTitles";

const stateLabels: Record<string, MessageKey> = {
  initializing: "downloads.state.initializing",
  paused: "downloads.state.paused",
  queued: "status.queued",
  error: "downloads.state.error",
};

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

function seasonsLabel(seasons: number[]): string {
  if (seasons.length === 0) return "";
  const sorted = [...seasons].sort((a, b) => a - b);
  if (sorted.length === 1) return t("common.season", { season: sorted[0] });
  return t("downloads.group.seasons", { from: sorted[0], to: sorted[sorted.length - 1] });
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

function TorrentGroup({ title, torrents, titles }: { title: TorrentTitle; torrents: TorrentView[]; titles: Record<string, TorrentTitle> }) {
  const { tn } = useT();
  const done = torrents.filter((torrent) => torrent.finished).length;
  const speed = torrents.reduce((sum, torrent) => sum + torrent.downloadSpeed, 0);
  const ordered = [...torrents].sort((a, b) => (Math.min(...(titles[a.infoHash]?.seasons ?? [0])) || 0) - (Math.min(...(titles[b.infoHash]?.seasons ?? [0])) || 0));
  return (
    <details className="torrent-group" open>
      <summary>
        <Link to={title.path} className="torrent-group__title" onClick={(event) => event.stopPropagation()}>
          {title.label}
        </Link>
        <span className="torrent-group__meta">
          {tn("downloads.group.count", torrents.length)}
          {done > 0 && done < torrents.length ? ` · ${t("downloads.group.done", { count: done })}` : ""}
          {speed > 0 ? ` · ↓ ${formatSpeed(speed)}` : ""}
        </span>
      </summary>
      <div className="torrent-list">
        {ordered.map((torrent) => (
          <TorrentCard key={torrent.infoHash} torrent={torrent} link={undefined} badge={seasonsLabel(titles[torrent.infoHash]?.seasons ?? [])} />
        ))}
      </div>
    </details>
  );
}

function TorrentCard({ torrent, link, badge }: { torrent: TorrentView; link?: { path: string; label: string }; badge?: string }) {
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
        void run(backend.remove(torrent.infoHash, deleteFiles).then(() => removeFromLibrary(torrent.infoHash)));
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
          {badge && <span className="torrent__badge">{badge}</span>}
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
          className={`torrent__upload ${torrent.uploadEnabled ? "is-on" : ""}`}
          aria-pressed={torrent.uploadEnabled}
          aria-label={t(torrent.uploadEnabled ? "downloads.upload.on" : "downloads.upload.off")}
          title={t(torrent.uploadEnabled ? "downloads.upload.onNote" : "downloads.upload.offNote")}
          onClick={() => void run(backend.setUpload(torrent.infoHash, !torrent.uploadEnabled))}
        >
          <ArrowUp size={14} />
          <span>{t(torrent.uploadEnabled ? "downloads.upload.on" : "downloads.upload.off")}</span>
        </button>
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
  const torrents = useMemo(() => everything.filter(isDownload), [everything]);
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
  const { groups, rest } = useMemo(() => {
    const bySeries = new Map<string, TorrentView[]>();
    const loose: TorrentView[] = [];
    for (const torrent of sorted) {
      const series = titles[torrent.infoHash]?.series;
      if (series) bySeries.set(series, [...(bySeries.get(series) ?? []), torrent]);
      else loose.push(torrent);
    }
    const grouped: { key: string; title: TorrentTitle; torrents: TorrentView[] }[] = [];
    for (const [key, list] of bySeries) {
      if (list.length === 1) loose.push(list[0]);
      else grouped.push({ key, title: titles[list[0].infoHash], torrents: list });
    }
    grouped.sort((a, b) => a.title.label.localeCompare(b.title.label));
    loose.sort((a, b) => Number(a.finished) - Number(b.finished) || a.name.localeCompare(b.name));
    return { groups: grouped, rest: loose };
  }, [sorted, titles]);

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
        <div className="torrent-groups">
          {groups.map((group) => (
            <TorrentGroup key={group.key} title={group.title} torrents={group.torrents} titles={titles} />
          ))}
          {rest.length > 0 && (
            <div className="torrent-list">
              {rest.map((torrent) => (
                <TorrentCard
                  key={torrent.infoHash}
                  torrent={torrent}
                  link={titles[torrent.infoHash]}
                  badge={seasonsLabel(titles[torrent.infoHash]?.seasons ?? [])}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
