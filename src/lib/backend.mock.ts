import type { AppInfo, TorrentPreview, TorrentView } from "./backend";

export const mockStreamUrl = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

const GiB = 1024 ** 3;
const storagePrefix = "kinuza-mock-store:";

const demoPreview: TorrentPreview = {
  infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  name: "Demo.Show.S01.1080p.WEB-DL",
  alreadyAdded: false,
  files: [
    ...Array.from({ length: 8 }, (_, i) => ({
      index: i,
      path: `Demo.Show.S01.1080p.WEB-DL/Demo.Show.S01E${String(i + 1).padStart(2, "0")}.1080p.WEB-DL.mkv`,
      length: 1.6 * GiB + i * 1e7,
      included: true,
      downloaded: 0,
    })),
    ...["ru", "en", "en.forced", "ger"].map((suffix, i) => ({
      index: 8 + i,
      path: `Demo.Show.S01.1080p.WEB-DL/Demo.Show.S01E01.1080p.WEB-DL.${suffix}.srt`,
      length: 60_000,
      included: true,
      downloaded: 0,
    })),
  ],
};

const torrents: TorrentView[] = [];
const startedAt = Date.now();

function tick(): TorrentView[] {
  const elapsed = (Date.now() - startedAt) / 1000;
  return torrents.map((torrent) => {
    const progress = Math.min(torrent.totalBytes, elapsed * 9e6);
    const finished = progress >= torrent.totalBytes;
    return {
      ...torrent,
      progressBytes: progress,
      finished,
      downloadSpeed: finished || torrent.state === "paused" ? 0 : 9e6 + Math.sin(elapsed) * 2e6,
      uploadSpeed: 4e5,
      peers: finished ? 3 : 24,
      files: torrent.files.map((file) => ({
        ...file,
        downloaded: Math.min(file.length, (progress / torrent.totalBytes) * file.length),
      })),
    };
  });
}

const demoTrackerItems = [
  ["UHD BDRip 2160p, HDR10] [IMAX] Dub (WinMedia, HDRezka Studio) + MVO (Jaskier) + Original Eng + Sub (Rus, Eng)", "36.59 GB", 883],
  ["BDRip 1080p] [IMAX] MVO (HDrezka) + Dub (HDrezka, WinMedia) + Original Eng + Sub (Rus, Eng)", "21.96 GB", 402],
  ["BDRip 720p] MVO (HDRezka Studio, Jaskier) + Dub (WinMedia) + Sub Rus, Eng", "8.05 GB", 310],
  ["HDRip-AVC] MVO (HDRezka Studio) + Dub (HDRezka Studio)", "2.17 GB", 204],
  ["Telesync-Rip-AVC] 2x MVO + Dub (Studio) + Sub", "1.46 GB", 12],
].map(([details, size, seeds], index) => ({
  id: String(6935000 + index),
  title: `Демо-фильм / Demo Film (Режиссёр / Director) [2026, США, приключения, драма, ${details}`,
  size,
  seeds,
  pageUrl: "https://example.com/",
}));

const demoTrackerOther = {
  id: "6935099",
  title: "Composer - Демо-фильм / Demo Film (Original Motion Picture Soundtrack) - 2026, FLAC (tracks+.cue), lossless",
  size: "581.7 MB",
  seeds: 37,
  pageUrl: "https://example.com/",
};

export async function mockInvoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (command) {
    case "online_subtitles_search":
      return [];
    case "tray_configure":
    case "log_write":
    case "logs_open":
    case "torrent_set_policy":
    case "write_text_file":
    case "file_pick":
    case "file_save_target":
      return null;
    case "storage_info":
      return { freeBytes: 180 * GiB, totalBytes: 930 * GiB, cacheBytes: 3.4 * GiB };
    case "stream_cache_clear":
      return 3.4 * GiB;
    case "ffmpeg_status":
      return { installed: false, installing: false, downloadedBytes: 0, totalBytes: 82 * 1024 * 1024 };
    case "imdb_rating":
      return { rating: 8.8, votes: 2_600_000 };
    case "rutracker_search":
      await new Promise((resolve) => setTimeout(resolve, 500));
      return [...demoTrackerItems.slice(0, 4), demoTrackerOther, ...demoTrackerItems.slice(4)];
    case "rutracker_login_window":
      return null;
    case "rutracker_video_sizes":
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { [demoTrackerItems[3].id]: { width: 1024, height: 426 } };
    case "rutracker_torrent_inspect":
      return demoPreview;
    case "rutracker_magnet":
      return `magnet:?xt=urn:btih:${demoPreview.infoHash}`;
    case "app_info":
      return {
        version: "0.1.0",
        streamBaseUrl: "http://127.0.0.1:0/preview",
        defaultDownloadDir: "C:\\Users\\you\\Videos\\Kinuza",
        externalPlayer: "VLC",
        sessionReset: false,
      } satisfies AppInfo;
    case "torrent_inspect":
      await new Promise((resolve) => setTimeout(resolve, 900));
      return demoPreview;
    case "torrent_add": {
      const selected = new Set(args.files as number[]);
      const files = demoPreview.files.map((file) => ({ ...file, included: selected.has(file.index) }));
      torrents.push({
        infoHash: demoPreview.infoHash,
        name: demoPreview.name,
        outputFolder: "C:\\Users\\you\\Videos\\Kinuza\\Demo.Show.S01.1080p.WEB-DL",
        state: "live",
        error: null,
        progressBytes: 0,
        totalBytes: files.filter((f) => f.included).reduce((sum, f) => sum + f.length, 0),
        uploadedBytes: 0,
        finished: false,
        downloadSpeed: 0,
        uploadSpeed: 0,
        peers: 0,
        files,
      });
      return null;
    }
    case "torrent_list":
      return tick();
    case "torrent_pause":
    case "torrent_resume": {
      const torrent = torrents.find((t) => t.infoHash === args.infoHash);
      if (torrent) torrent.state = command === "torrent_pause" ? "paused" : "live";
      return null;
    }
    case "torrent_hold":
    case "torrent_release":
      return null;
    case "torrent_select_files": {
      const torrent = torrents.find((t) => t.infoHash === args.infoHash);
      const wanted = new Set(args.files as number[]);
      if (torrent) {
        torrent.files = torrent.files.map((file) => (wanted.has(file.index) ? { ...file, included: true } : file));
        torrent.totalBytes = torrent.files.filter((file) => file.included).reduce((sum, file) => sum + file.length, 0);
      }
      return null;
    }
    case "torrent_delete": {
      const index = torrents.findIndex((t) => t.infoHash === args.infoHash);
      if (index >= 0) torrents.splice(index, 1);
      return null;
    }
    case "store_get": {
      const text = localStorage.getItem(storagePrefix + String(args.name));
      return text === null ? null : { text, recovered: false };
    }
    case "store_set":
      localStorage.setItem(storagePrefix + String(args.name), String(args.value));
      return null;
    case "take_launch_request":
      return null;
    case "associations_status":
    case "associations_set":
      return { enabled: Boolean(args.enabled), overriddenByWindows: false };
    case "file_location":
      return "C:\\Users\\you\\Videos\\Kinuza\\demo.mkv";
    case "open_external":
      return "VLC";
    default:
      return null;
  }
}
