// Stand-in backend for previewing the UI in a browser. Never used inside the desktop app.

import type { AppInfo, TorrentPreview, TorrentView } from "./backend";

/** A small CC0 clip so the player can be previewed without the torrent engine. */
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

export async function mockInvoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (command) {
    case "app_info":
      return {
        version: "0.1.0",
        streamBaseUrl: "http://127.0.0.1:0/preview",
        defaultDownloadDir: "C:\\Users\\you\\Videos\\Kinuza",
        externalPlayer: "VLC",
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
    case "torrent_delete": {
      const index = torrents.findIndex((t) => t.infoHash === args.infoHash);
      if (index >= 0) torrents.splice(index, 1);
      return null;
    }
    case "store_get":
      return localStorage.getItem(storagePrefix + String(args.name));
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
