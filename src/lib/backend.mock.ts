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

const demoSeriesPreview: TorrentPreview = {
  infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  name: "Jojo's Bizarre Adventure Stardust Crusaders - Egypt Hen [BDRip 1080p]",
  alreadyAdded: false,
  files: Array.from({ length: 24 }, (_, i) => ({
    index: i,
    path: `Jojo's Bizarre Adventure Stardust Crusaders - Egypt Hen [BDRip 1080p]/[Some-Stuffs]_Jojo's_Bizarre_Adventure_Stardust_Crusaders_${String(i + 1).padStart(2, "0")}_(${i + 25})_(1920x1080_Hi10P_BDRip_FLAC).mkv`,
    length: 1.6 * GiB + i * 1e7,
    included: true,
    downloaded: 0,
  })),
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
      uploadSpeed: torrent.uploadEnabled ? 4e5 : 0,
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

const demoSeriesItems = [
  ["Невероятные приключения ДжоДжо: Гонка «Стальной шар» (ТВ-7) / Steel Ball Run: JoJo no Kimyou na Bouken [ONA] [01-08 из XX] [2026, приключения, WEB-DL] [1080p] [UKR, ENG, JAP+Sub]", "8.85 GB", 75],
  ["Невероятные Приключения ДжоДжо (ТВ-1) / JoJo no Kimyou na Bouken / JoJo's Bizarre Adventure [TV] [26 из 26] [2012-2013, приключения, BDRip] [1080p] [RUS(ext), JAP+Sub]", "38.77 GB", 47],
  ["Невероятные приключения ДжоДжо: Каменный океан (ТВ-6, часть 3) / JoJo no Kimyou na Bouken: Stone Ocean [ONA] [14 из 14] [2022, BDRip] [1080p] [JAP+Sub]", "20.31 GB", 46],
  ["Невероятные приключения ДжоДжо: Каменный океан (ТВ-6, часть 1) / JoJo no Kimyou na Bouken: Stone Ocean [ONA] [12 из 12] [2021, WEB-DL] [1080p] [RUS(int), JAP+Sub]", "14.1 GB", 31],
  ["Невероятные приключения ДжоДжо: Крестоносцы звёздной пыли (ТВ-2) / JoJo no Kimyou na Bouken: Stardust Crusaders [TV] [24 из 24] [2014, BDRip] [1080p] [RUS(ext), JAP+Sub]", "30.2 GB", 22],
  ["Невероятные приключения ДжоДжо: Крестоносцы звёздной пыли - Битва в Египте (ТВ-3) / JoJo no Kimyou na Bouken: Stardust Crusaders - Egypt-hen [TV] [24 из 24] [2015, BDRip] [1080p]", "29.7 GB", 19],
  ["Невероятные приключения ДжоДжо: Несокрушимый алмаз (ТВ-4) / JoJo no Kimyou na Bouken: Diamond wa Kudakenai [TV] [39 из 39] [2016, BDRip] [1080p] [RUS(ext), JAP+Sub]", "52.4 GB", 15],
  ["Невероятные приключения ДжоДжо: Золотой ветер (ТВ-5) / JoJo no Kimyou na Bouken: Ougon no Kaze [TV] [39 из 39] [2018-2019, BDRip] [1080p] [JAP+Sub]", "48.9 GB", 14],
  ["Невероятные приключения ДжоДжо (ТВ-1 - ТВ-6) / JoJo no Kimyou na Bouken [TV] [190 из 190] [2012-2023, BDRip] [720p] [RUS(ext), JAP+Sub]", "120 GB", 9],
  ["JoJo no Kimyou na Bouken: Stone Ocean [ONA] [01-38 из 38] [2021-2022, WEB-DL] [1080p] [JAP+Sub]", "41 GB", 6],
].map(([title, size, seeds], index) => ({ id: String(7100000 + index), title: String(title), size: String(size), seeds: Number(seeds), pageUrl: "https://example.com/" }));

function demoWords(text: string): string[] {
  return text.toLowerCase().replace(/ё/g, "е").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export async function mockInvoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (command) {
    case "online_subtitles_search":
    case "shikimori_names":
    case "shikimori_search":
    case "wikidata_by_mal":
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
      if (demoWords(String(args.query ?? "")).some((word) => word === "джоджо" || word === "jojo")) {
        if (Number(args.page ?? 0) > 0) return [];
        const wanted = demoWords(String(args.query));
        return demoSeriesItems.filter((item) => {
          const words = new Set(demoWords(item.title));
          return wanted.every((word) => words.has(word));
        });
      }
      return [...demoTrackerItems.slice(0, 4), demoTrackerOther, ...demoTrackerItems.slice(4)];
    case "rutracker_login_window":
      return null;
    case "rutracker_video_sizes":
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { [demoTrackerItems[3].id]: { width: 1024, height: 426 } };
    case "rutracker_torrent_inspect":
      return String(args.id ?? "").startsWith("7100") ? demoSeriesPreview : demoPreview;
    case "rutracker_magnet":
      return `magnet:?xt=urn:btih:${demoPreview.infoHash}`;
    case "app_info":
      return {
        version: "0.1.0",
        streamBaseUrl: "http://127.0.0.1:0/preview",
        defaultDownloadDir: "C:\\Users\\you\\Videos\\Kinuza",
        externalPlayer: "VLC",
        sessionReset: false,
        listenPort: 51413,
        updatedFrom: null,
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
        uploadEnabled: true,
      });
      return null;
    }
    case "torrent_list":
      return tick();
    case "storage_report":
      return {
        downloadsDisk: { path: "C:\Users\you\Videos\Kinuza", freeBytes: 182 * GiB, totalBytes: 931 * GiB },
        dataDisk: { path: "C:\Users\you\AppData\Roaming\com.lembegor.kinuza", freeBytes: 182 * GiB, totalBytes: 931 * GiB },
        cache: [
          { infoHash: "7100004", name: "Stardust Crusaders [BDRip 1080p]", bytes: 6.4 * GiB, lastPlayed: Date.now() - 2 * 864e5, inUse: false },
          { infoHash: "cccccccccccccccccccccccccccccccccccccccc", name: "Demo Film 2026 BDRip 1080p", bytes: 3.1 * GiB, lastPlayed: Date.now() - 9 * 864e5, inUse: false },
        ],
        parts: [
          { id: "library", bytes: 17e6, clearable: false, later: false },
          { id: "ffmpeg", bytes: 153e6, clearable: true, later: false },
          { id: "imdb", bytes: 15e6, clearable: true, later: false },
          { id: "fingerprints", bytes: 7e4, clearable: true, later: false },
          { id: "logs", bytes: 2.8e5, clearable: true, later: false },
          { id: "webCache", bytes: 240e6, clearable: true, later: true },
          { id: "webData", bytes: 83e6, clearable: false, later: false },
        ],
        webCachePending: false,
      };
    case "storage_clear_part":
      return 12e6;
    case "storage_drop_cached":
    case "storage_free_download":
      return 2 * GiB;
    case "torrent_set_upload": {
      const torrent = torrents.find((t) => t.infoHash === args.infoHash);
      if (torrent) torrent.uploadEnabled = Boolean(args.enabled);
      return null;
    }
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
