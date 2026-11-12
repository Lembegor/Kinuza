import { useEffect, useState, type RefObject } from "react";
import { X } from "lucide-react";
import type { TorrentView } from "../../lib/backend";
import { formatBytes, formatSpeed } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { mpv } from "../../lib/mpv";

const refreshMs = 1000;

interface Row {
  label: string;
  value: string;
}

function text(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

function bitrate(value: unknown, format: (megabits: string) => string): string {
  return typeof value === "number" && value > 0 ? format((value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)) : "";
}

function bufferedAhead(video: HTMLVideoElement): number {
  const ranges = video.buffered;
  for (let index = 0; index < ranges.length; index++) {
    if (ranges.start(index) <= video.currentTime + 0.5 && ranges.end(index) > video.currentTime) return ranges.end(index) - video.currentTime;
  }
  return 0;
}

export function StatsPanel({
  usingMpv,
  videoRef,
  videoCodec,
  torrent,
  fileProgress,
  fileSize,
  onClose,
}: {
  usingMpv: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  videoCodec: string;
  torrent: TorrentView | undefined;
  fileProgress: number;
  fileSize: number;
  onClose: () => void;
}) {
  const { t } = useT();
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let cancelled = false;
    const collect = async () => {
      const list: Row[] = [];
      const mbps = (value: string) => t("player.stats.mbps", { value });
      if (usingMpv) {
        const stats = await mpv.stats().catch(() => ({}) as Record<string, unknown>);
        const size = stats.width && stats.height ? `${text(stats.width)}×${text(stats.height)}` : "";
        const fps = text(stats["estimated-vf-fps"] ?? stats["container-fps"]);
        list.push({ label: t("player.stats.video"), value: [text(stats["video-format"] ?? stats["video-codec"]).toUpperCase(), size, fps && `${fps} fps`].filter(Boolean).join(" · ") });
        list.push({ label: t("player.stats.bitrate"), value: bitrate(stats["video-bitrate"], mbps) });
        list.push({ label: t("player.stats.decoder"), value: text(stats["hwdec-current"]) === "no" || !stats["hwdec-current"] ? t("player.stats.software") : `${t("player.stats.hardware")} (${text(stats["hwdec-current"])})` });
        list.push({ label: t("player.stats.hdr"), value: [text(stats["video-params/primaries"]), text(stats["video-params/gamma"])].filter(Boolean).join(" / ") });
        list.push({
          label: t("player.stats.dropped"),
          value: t("player.stats.droppedValue", { output: text(stats["frame-drop-count"]) || "0", decoder: text(stats["decoder-frame-drop-count"]) || "0" }),
        });
        list.push({ label: t("player.stats.display"), value: stats["display-fps"] ? `${text(stats["display-fps"])} ${t("player.stats.hz")}` : "" });
        const channels = text(stats["audio-params/channel-count"]);
        list.push({
          label: t("player.stats.audio"),
          value: [text(stats["audio-codec-name"]).toUpperCase(), channels && t("player.stats.channels", { count: channels }), stats["audio-params/samplerate"] ? `${Math.round(Number(stats["audio-params/samplerate"]) / 100) / 10} kHz` : "", bitrate(stats["audio-bitrate"], mbps)]
            .filter(Boolean)
            .join(" · "),
        });
        const cached = Number(stats["demuxer-cache-duration"]);
        list.push({ label: t("player.stats.buffer"), value: Number.isFinite(cached) ? t("player.stats.seconds", { seconds: Math.round(cached) }) : "" });
      } else {
        const video = videoRef.current;
        if (video) {
          const quality = video.getVideoPlaybackQuality?.();
          list.push({ label: t("player.stats.video"), value: [videoCodec.toUpperCase(), video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : ""].filter(Boolean).join(" · ") });
          if (quality) {
            list.push({ label: t("player.stats.dropped"), value: t("player.stats.droppedOf", { dropped: quality.droppedVideoFrames, total: quality.totalVideoFrames }) });
          }
          list.push({ label: t("player.stats.buffer"), value: t("player.stats.seconds", { seconds: Math.round(bufferedAhead(video)) }) });
        }
      }
      if (torrent) {
        list.push({ label: t("player.stats.file"), value: `${formatBytes(fileSize)} · ${fileProgress >= 1 ? t("common.downloaded") : `${(fileProgress * 100).toFixed(1)}%`}` });
        if (fileProgress < 1) {
          list.push({ label: t("player.stats.network"), value: `↓ ${formatSpeed(torrent.downloadSpeed)} · ↑ ${formatSpeed(torrent.uploadSpeed)} · ${t("player.stats.peers", { count: torrent.peers })}` });
        }
      }
      if (!cancelled) setRows(list.filter((row) => row.value));
    };
    void collect();
    const timer = setInterval(() => void collect(), refreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [usingMpv, videoRef, videoCodec, torrent, fileProgress, fileSize, t]);

  return (
    <div className="player__stats-panel" role="dialog" aria-label={t("player.stats.title")}>
      <div className="player__stats-head">
        <strong>{t("player.stats.title")}</strong>
        <button className="icon-button" aria-label={t("common.close")} onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <dl>
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
