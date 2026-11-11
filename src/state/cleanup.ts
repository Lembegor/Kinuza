// Frees disk space by itself: a download whose every film or episode has been watched is deleted,
// if the user asked for that in the settings.

import { backend } from "../lib/backend";
import { t } from "../lib/i18n";
import { report } from "../lib/journal";
import { isWatched, useLibrary } from "./library";
import { useSettings } from "./settings";
import { useTorrents } from "./torrents";
import { useUi } from "./ui";

/** Watching the last minutes and closing the player settle first; then the check runs. */
const checkDelayMs = 4000;

function deleteWatchedDownloads(): void {
  if (!useSettings.getState().autoDeleteWatched) return;
  const { sources, progress } = useLibrary.getState();
  const { byHash } = useTorrents.getState();
  const playing = useUi.getState().player?.unitKey;

  const unitsByTorrent = new Map<string, string[]>();
  for (const [unit, list] of Object.entries(sources)) {
    for (const source of list) unitsByTorrent.set(source.infoHash, [...(unitsByTorrent.get(source.infoHash) ?? []), unit]);
  }

  for (const [infoHash, units] of unitsByTorrent) {
    const torrent = byHash[infoHash];
    // Only finished downloads: a torrent watched online keeps nothing on disk, an unfinished one is still wanted.
    const downloaded = torrent !== undefined && torrent.finished && torrent.totalBytes > 0;
    if (!downloaded || units.includes(playing ?? "") || !units.every((unit) => isWatched(progress[unit]))) continue;

    void backend
      .remove(infoHash, true)
      .then(() => {
        useLibrary.getState().removeTorrent(infoHash);
        void useTorrents.getState().refresh();
        useUi.getState().toast(t("settings.autoDelete.done", { title: torrent.name }), "info");
      })
      .catch((error) => report("downloads", "journal.cleanup.failed", error));
  }
}

/** Starts watching the library for downloads that have been watched through. Returns a stop function. */
export function startWatchedCleanup(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(deleteWatchedDownloads, checkDelayMs);
  };
  const stopLibrary = useLibrary.subscribe(schedule);
  const stopPlayer = useUi.subscribe(schedule);
  return () => {
    clearTimeout(timer);
    stopLibrary();
    stopPlayer();
  };
}
