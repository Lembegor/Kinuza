import { useMemo } from "react";
import { backend, type StorageReport, type TorrentView } from "../lib/backend";
import { formatBytes } from "../lib/format";
import { useT } from "../lib/i18n";
import { useAsync } from "../lib/useAsync";
import { useSettings } from "../state/settings";
import { isDownload, useTorrents } from "../state/torrents";

export const lowSpaceShare = 0.05;
export const lowSpaceBytes = 10 * 1024 ** 3;

export function downloadedBytes(torrent: TorrentView): number {
  return torrent.files.filter((file) => file.included).reduce((sum, file) => sum + file.downloaded, 0);
}

export interface StorageTotals {
  downloads: number;
  cache: number;
  app: number;
  free: number;
  total: number;
  other: number;
  lowSpace: boolean;
}

export function totalsOf(report: StorageReport | null | undefined, torrents: TorrentView[]): StorageTotals | null {
  const disk = report?.downloadsDisk ?? report?.dataDisk;
  if (!report || !disk) return null;
  const downloads = torrents.filter(isDownload).reduce((sum, torrent) => sum + downloadedBytes(torrent), 0);
  const cache = report.cache.reduce((sum, item) => sum + item.bytes, 0);
  const app = report.parts.reduce((sum, part) => sum + part.bytes, 0);
  const sameDisk = !report.dataDisk || !report.downloadsDisk || report.dataDisk.totalBytes === report.downloadsDisk.totalBytes;
  const ours = downloads + (sameDisk ? cache + app : 0);
  const used = Math.max(0, disk.totalBytes - disk.freeBytes);
  return {
    downloads,
    cache,
    app,
    free: disk.freeBytes,
    total: disk.totalBytes,
    other: Math.max(0, used - ours),
    lowSpace: disk.freeBytes < lowSpaceBytes || disk.freeBytes < disk.totalBytes * lowSpaceShare,
  };
}

export function useStorageReport(version = 0) {
  const downloadDir = useSettings((state) => state.downloadDir);
  return useAsync(() => backend.storageReport(downloadDir || null), [downloadDir, version]);
}

export function useStorageTotals(report: StorageReport | null | undefined): StorageTotals | null {
  const torrents = useTorrents((state) => state.list);
  return useMemo(() => totalsOf(report, torrents), [report, torrents]);
}

const segments = ["downloads", "cache", "app", "other"] as const;

export function StorageBar({ totals, large = false }: { totals: StorageTotals; large?: boolean }) {
  const { t } = useT();
  const share = (bytes: number) => (totals.total > 0 ? (bytes / totals.total) * 100 : 0);
  return (
    <div className={`storage-meter ${large ? "storage-meter--large" : ""}`}>
      <p className="storage-total">
        <strong>{formatBytes(totals.downloads + totals.cache + totals.app)}</strong>
        <span>{t("storage.total", { free: formatBytes(totals.free) })}</span>
      </p>
      <div className="storage-bar" role="img" aria-label={t("storage.bar", { free: formatBytes(totals.free), total: formatBytes(totals.total) })}>
        {segments.map((segment) => {
          const width = share(totals[segment]);
          return width > 0 ? <i key={segment} className={`storage-bar__part storage-bar__part--${segment}`} style={{ width: `${Math.max(width, 0.6)}%` }} /> : null;
        })}
      </div>
      <ul className="storage-legend">
        {segments.map((segment) => (
          <li key={segment}>
            <i className={`storage-legend__dot storage-legend__dot--${segment}`} />
            <span>{t(`storage.segment.${segment}`)}</span>
            <strong>{formatBytes(totals[segment])}</strong>
          </li>
        ))}
        <li>
          <i className="storage-legend__dot storage-legend__dot--free" />
          <span>{t("storage.segment.free")}</span>
          <strong className={totals.lowSpace ? "is-low" : ""}>{formatBytes(totals.free)}</strong>
        </li>
      </ul>
    </div>
  );
}
