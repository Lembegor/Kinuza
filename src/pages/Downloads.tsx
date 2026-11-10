import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, Download, FolderOpen, Pause, Play, Plus, Trash2, Users } from "lucide-react";
import { EmptyState } from "../components/Cards";
import { backend, describeError, isDesktop, type TorrentView } from "../lib/backend";
import { formatBytes, formatEta, formatSpeed } from "../lib/format";
import { useLibrary, type Progress, type Source } from "../state/library";
import { etaSeconds, torrentProgress, useTorrents } from "../state/torrents";
import { useUi } from "../state/ui";

const stateLabels: Record<string, string> = {
  initializing: "Проверка файлов",
  paused: "Пауза",
  error: "Ошибка",
};

function statusText(torrent: TorrentView): string {
  if (torrent.state !== "live") return stateLabels[torrent.state] ?? torrent.state;
  if (torrent.finished) return "Скачано · раздаётся";
  const eta = formatEta(etaSeconds(torrent));
  return eta ? `Осталось ${eta}` : "Поиск участников";
}

/** Maps info hashes to the title they were attached to, using saved sources and watch history. */
function useTorrentTitles(): Record<string, { path: string; label: string }> {
  const sources = useLibrary((state) => state.sources);
  const saved = useLibrary((state) => state.saved);
  const progress = useLibrary((state) => state.progress);

  return useMemo(() => {
    const names = new Map<string, string>();
    for (const [key, title] of Object.entries(saved)) names.set(key, title.title);
    for (const item of Object.values<Progress>(progress)) names.set(`${item.title.type}:${item.title.id}`, item.title.title);

    const result: Record<string, { path: string; label: string }> = {};
    for (const [unit, list] of Object.entries<Source[]>(sources)) {
      const [type, id] = unit.split(":");
      for (const source of list) {
        result[source.infoHash] ??= {
          path: `/title/${type}/${id}`,
          label: names.get(`${type}:${id}`) ?? "Открыть страницу",
        };
      }
    }
    return result;
  }, [sources, saved, progress]);
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
  const progress = torrentProgress(torrent);
  const paused = torrent.state === "paused";

  const remove = () =>
    askConfirm({
      title: "Удалить загрузку?",
      message: torrent.name,
      confirmLabel: "Удалить",
      optionLabel: "Удалить и скачанные файлы с диска",
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
            {formatBytes(torrent.progressBytes)} из {formatBytes(torrent.totalBytes)}
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
          aria-label={paused ? "Продолжить" : "Пауза"}
          onClick={() => void run(paused ? backend.resume(torrent.infoHash) : backend.pause(torrent.infoHash))}
        >
          {paused ? <Play size={17} /> : <Pause size={17} />}
        </button>
        <button className="icon-button" aria-label="Открыть папку" onClick={() => void openFolder(torrent.outputFolder)}>
          <FolderOpen size={17} />
        </button>
        <button className="icon-button" aria-label="Удалить" onClick={remove}>
          <Trash2 size={17} />
        </button>
      </div>
    </div>
  );
}

export default function Downloads() {
  const torrents = useTorrents((state) => state.list);
  const openAddSource = useUi((state) => state.openAddSource);
  const titles = useTorrentTitles();

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
        <h1>Загрузки</h1>
        {torrents.length > 0 && (
          <span className="section__note">
            ↓ {formatSpeed(totals.down)} · ↑ {formatSpeed(totals.up)}
          </span>
        )}
        <button className="button button--primary" onClick={() => openAddSource({ target: null })}>
          <Plus size={16} />
          Добавить торрент
        </button>
      </div>
      {sorted.length === 0 ? (
        <EmptyState
          icon={<Download size={40} />}
          title="Загрузок нет"
          text="Добавьте magnet-ссылку или .torrent-файл: вставьте ссылку (Ctrl+V) в любом месте приложения или перетащите файл в окно."
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
