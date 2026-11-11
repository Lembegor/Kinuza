import { isDesktop } from "../lib/backend";
import { t, tn } from "../lib/i18n";
import { report } from "../lib/journal";
import { newEpisodes, type CalendarEpisode } from "./calendar";
import { useLibrary } from "./library";
import { checkReleaseUpdates } from "./releaseWatch";
import { useSettings } from "./settings";
import { useTorrents } from "./torrents";

const announcedKey = "kinuza.announcedEpisodes";
const episodeCheckIntervalMs = 3 * 60 * 60 * 1000;
const separateNotifications = 3;
const announcedLimit = 2000;

const episodeId = (episode: CalendarEpisode) => `${episode.title.id}:${episode.season}:${episode.episode}`;

function readAnnounced(): string[] | null {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(announcedKey) ?? "null");
    return Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : null;
  } catch {
    return null;
  }
}

export function episodeAnnouncements(fresh: CalendarEpisode[]): { title: string; body: string }[] {
  const bySeries = new Map<number, CalendarEpisode[]>();
  for (const episode of fresh) bySeries.set(episode.title.id, [...(bySeries.get(episode.title.id) ?? []), episode]);
  const series = [...bySeries.values()];
  if (series.length > separateNotifications) {
    const names = series.slice(0, separateNotifications).map((episodes) => episodes[0].title.title);
    return [
      {
        title: t("notifications.episodes.many"),
        body: t("notifications.episodes.andMore", { titles: names.join(", "), count: series.length - separateNotifications }),
      },
    ];
  }
  return series.map((episodes) => {
    const [first] = episodes;
    const body =
      episodes.length === 1
        ? `${t("notifications.episode.number", { season: first.season, episode: first.episode })} · ${first.name}`
        : tn("calendar.new.count", episodes.length);
    return { title: first.title.title, body };
  });
}

async function announceNewEpisodes(): Promise<void> {
  const episodes = await newEpisodes();
  const known = readAnnounced();
  const seen = new Set(known ?? []);
  const fresh = episodes.filter((episode) => !seen.has(episodeId(episode)));
  if (fresh.length === 0 && known !== null) return;
  localStorage.setItem(announcedKey, JSON.stringify([...seen, ...fresh.map(episodeId)].slice(-announcedLimit)));
  if (known === null || !useSettings.getState().notifyEpisodes) return;
  for (const { title, body } of episodeAnnouncements(fresh)) await notify(title, body);
}

export function startEpisodeNotifications(): void {
  if (!isDesktop) return;
  const check = async () => {
    await announceNewEpisodes().catch((error) => report("system", "journal.notifications.failed", error));
    for (const { title, count } of await checkReleaseUpdates()) {
      if (!useSettings.getState().notifyEpisodes) break;
      await notify(t("notifications.episodes.added"), `${title.title} · ${tn("common.episodes", count)}`).catch((error) =>
        report("system", "journal.notifications.failed", error),
      );
    }
  };
  const begin = () => {
    void check();
    setInterval(() => void check(), episodeCheckIntervalMs);
  };
  if (useLibrary.getState().loaded) {
    begin();
    return;
  }
  const stop = useLibrary.subscribe((state) => {
    if (!state.loaded) return;
    stop();
    begin();
  });
}

export async function notify(title: string, body: string): Promise<void> {
  const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
  const allowed = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  if (allowed) sendNotification({ title, body });
}

export function startDownloadNotifications(): void {
  if (!isDesktop) return;
  const unfinished = new Set<string>();
  useTorrents.subscribe((state) => {
    for (const torrent of state.list) {
      const downloading = !torrent.finished && torrent.totalBytes > 0;
      if (downloading) {
        unfinished.add(torrent.infoHash);
      } else if (torrent.finished && unfinished.delete(torrent.infoHash) && useSettings.getState().notifyDownloads) {
        void notify(t("notifications.downloaded"), torrent.name).catch((error) => report("system", "journal.notifications.failed", error));
      }
    }
  });
}
