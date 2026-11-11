// "What happened": when something does not work, this page says why in plain words. A set of
// checks of what the app depends on, and the journal of problems it ran into lately.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CircleAlert, CircleCheck, Copy, FolderOpen, Info, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { backend, describeError, getAppInfo, isDesktop } from "../lib/backend";
import { formatBytes, formatMoment } from "../lib/format";
import { t, useT, type MessageKey } from "../lib/i18n";
import { clearJournal, loadJournal, useJournal, type JournalArea, type JournalEntry } from "../lib/journal";
import { rutracker, rutrackerErrors } from "../lib/rutracker";
import { catalogHealth } from "../lib/tmdb";
import { useSettings } from "../state/settings";
import { useUi } from "../state/ui";

const GiB = 1024 ** 3;
/** Below this a film in good quality may not fit; below `lowSpaceBytes` hardly anything will. */
const tightSpaceBytes = 20 * GiB;
const lowSpaceBytes = 5 * GiB;
/** What the tracker is asked to see whether it answers; any word would do. */
const trackerProbeQuery = "Kinuza";
/** Torrents named in the hint before the rest are only counted. */
const namedTorrentsLimit = 3;
/**
 * The key for searching subtitles on the internet is built into the app, like the player's own
 * reference to it; without one that search is not offered.
 */
const onlineSubtitlesKey: string = import.meta.env.VITE_OPENSUBTITLES_API_KEY ?? "";

/** "ok": works. "note": worth knowing, nothing to fix. "problem": this is why something does not work. */
type CheckStatus = "ok" | "note" | "problem";

interface CheckResult {
  status: CheckStatus;
  /** The state in a few words. */
  text: string;
  /** What to do about it, or why it is fine. */
  hint?: string;
  /** Where the thing can be fixed. */
  link?: { to: string; label: string };
}

interface Check {
  id: string;
  title: MessageKey;
  run: () => Promise<CheckResult>;
}

function settingsLink(): CheckResult["link"] {
  return { to: "/settings", label: t("diagnostics.openSettings") };
}

async function checkCatalog(): Promise<CheckResult> {
  const health = await catalogHealth();
  if (health === "ok") return { status: "ok", text: t("diagnostics.catalog.ok") };
  if (health === "unreachable") {
    return { status: "problem", text: t("diagnostics.catalog.unreachable"), hint: t("diagnostics.catalog.unreachable.hint") };
  }
  return { status: "problem", text: t(`diagnostics.catalog.${health}`), hint: t(`diagnostics.catalog.${health}.hint`), link: settingsLink() };
}

/** The tracker's page came, but not in a shape the app can read. */
const unreadablePageErrors: string[] = [rutrackerErrors.parseFailed, rutrackerErrors.markupChanged, rutrackerErrors.unexpectedPage];

async function checkTracker(): Promise<CheckResult> {
  try {
    await rutracker.search(trackerProbeQuery);
    return { status: "ok", text: t("diagnostics.tracker.ok") };
  } catch (error) {
    // "tracker_unexpected_page" is followed by the page's title after a colon.
    const code = String(error).split(":")[0];
    // Not being signed in is how the app starts out; the forum did answer.
    if (code === rutrackerErrors.authRequired) {
      return { status: "note", text: t("diagnostics.tracker.signedOut"), hint: t("diagnostics.tracker.signedOut.hint") };
    }
    if (code === rutrackerErrors.cancelled) {
      return { status: "note", text: t("diagnostics.tracker.cancelled"), hint: t("diagnostics.tracker.cancelled.hint") };
    }
    if (code === rutrackerErrors.timeout) {
      return { status: "problem", text: t("diagnostics.tracker.timeout"), hint: t("diagnostics.tracker.timeout.hint") };
    }
    if (unreadablePageErrors.includes(code)) {
      return { status: "problem", text: t("diagnostics.tracker.unreadable"), hint: t("diagnostics.tracker.unreadable.hint") };
    }
    return { status: "problem", text: t("diagnostics.tracker.failed"), hint: describeError(error) };
  }
}

async function checkSubtitles(): Promise<CheckResult> {
  if (onlineSubtitlesKey) return { status: "ok", text: t("diagnostics.subtitles.ok") };
  return { status: "note", text: t("diagnostics.subtitles.noKey"), hint: t("diagnostics.subtitles.noKey.hint") };
}

async function checkFfmpeg(): Promise<CheckResult> {
  const status = await backend.ffmpegStatus();
  if (status.installed) return { status: "ok", text: t("diagnostics.ffmpeg.installed") };
  if (status.installing) {
    const percent = status.totalBytes > 0 ? Math.round((status.downloadedBytes / status.totalBytes) * 100) : 0;
    return { status: "note", text: t("diagnostics.ffmpeg.installing", { percent }) };
  }
  return {
    status: "note",
    text: t("diagnostics.ffmpeg.missing"),
    hint: t("diagnostics.ffmpeg.missing.hint", { size: formatBytes(status.totalBytes) }),
  };
}

async function checkDisk(): Promise<CheckResult> {
  const { freeBytes, totalBytes } = await backend.storageInfo(useSettings.getState().downloadDir || null);
  const text = t("diagnostics.disk.free", { free: formatBytes(freeBytes), total: formatBytes(totalBytes) });
  if (freeBytes < lowSpaceBytes) return { status: "problem", text, hint: t("diagnostics.disk.low.hint"), link: settingsLink() };
  if (freeBytes < tightSpaceBytes) return { status: "note", text, hint: t("diagnostics.disk.tight.hint") };
  return { status: "ok", text };
}

async function checkTorrents(): Promise<CheckResult> {
  const failed = (await backend.listTorrents()).filter((torrent) => torrent.state === "error");
  if (failed.length === 0) return { status: "ok", text: t("diagnostics.torrents.ok") };
  const named = failed
    .slice(0, namedTorrentsLimit)
    .map((torrent) => (torrent.error ? `«${torrent.name}» (${torrent.error})` : `«${torrent.name}»`))
    .join("; ");
  const rest = failed.length - namedTorrentsLimit;
  const names = rest > 0 ? t("diagnostics.torrents.more", { names: named, count: rest }) : named;
  return {
    status: "problem",
    text: t("diagnostics.torrents.errors", { count: failed.length }),
    hint: t("diagnostics.torrents.errors.hint", { names }),
    link: { to: "/downloads", label: t("diagnostics.openDownloads") },
  };
}

const checks: Check[] = [
  { id: "catalog", title: "diagnostics.catalog", run: checkCatalog },
  { id: "tracker", title: "diagnostics.tracker", run: checkTracker },
  { id: "subtitles", title: "diagnostics.subtitles", run: checkSubtitles },
  { id: "ffmpeg", title: "diagnostics.ffmpeg", run: checkFfmpeg },
  { id: "disk", title: "diagnostics.disk", run: checkDisk },
  { id: "torrents", title: "diagnostics.torrents", run: checkTorrents },
];

/** Runs every check at once; each reports as soon as it is done. A result still pending is absent. */
function useChecks(): { results: Record<string, CheckResult>; running: boolean; run: () => void } {
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  const [pending, setPending] = useState(0);
  /** Counts runs, so that a slow answer from an earlier run does not overwrite a newer one. */
  const latestRun = useRef(0);

  const run = useCallback(() => {
    const thisRun = ++latestRun.current;
    setResults({});
    setPending(checks.length);
    for (const check of checks) {
      void check
        .run()
        // A check that itself breaks down is a finding too: the thing could not even be asked.
        .catch((error): CheckResult => ({ status: "problem", text: t("diagnostics.failed"), hint: describeError(error) }))
        .then((result) => {
          if (thisRun !== latestRun.current) return;
          setResults((earlier) => ({ ...earlier, [check.id]: result }));
          setPending((count) => count - 1);
        });
    }
  }, []);

  useEffect(() => {
    run();
    // Leaving the page abandons the run in flight.
    return () => {
      latestRun.current++;
    };
  }, [run]);

  return { results, running: pending > 0, run };
}

const statusIcons = { ok: CircleCheck, note: Info, problem: CircleAlert };

function CheckRow({ check, result }: { check: Check; result: CheckResult | undefined }) {
  const { t } = useT();
  const navigate = useNavigate();
  const link = result?.link;
  const Icon = result ? statusIcons[result.status] : LoaderCircle;
  return (
    <div className={`setting diagnostic diagnostic--${result?.status ?? "pending"}`}>
      <Icon size={20} className={`diagnostic__icon ${result ? "" : "spin"}`} />
      <div className="diagnostic__body">
        <strong>{t(check.title)}</strong>
        <p className="diagnostic__status">{result ? result.text : t("diagnostics.checking")}</p>
        {result?.hint && <p>{result.hint}</p>}
      </div>
      {link && (
        <div className="setting__actions">
          <button className="button" onClick={() => navigate(link.to)}>
            {link.label}
          </button>
        </div>
      )}
    </div>
  );
}

const areaNames: Record<JournalArea, MessageKey> = {
  catalog: "journal.area.catalog",
  downloads: "journal.area.downloads",
  player: "journal.area.player",
  import: "journal.area.import",
  settings: "journal.area.settings",
  updates: "journal.area.updates",
  system: "journal.area.system",
};

/** An area recorded by a version of the app that had other areas is shown as it was written. */
function areaName(area: JournalArea): string {
  const key = areaNames[area];
  return key ? t(key) : area;
}

/** The journal as text to paste into a message, newest first like on the page. */
function journalText(entries: JournalEntry[], version: string, locale: string): string {
  const heading = t("diagnostics.journal.heading", { version, time: new Date().toLocaleString(locale) });
  const lines = entries.map((entry) => {
    const repeated = entry.count > 1 ? ` — ${t("diagnostics.journal.repeated", { count: entry.count })}` : "";
    const detail = entry.detail ? ` [${entry.detail}]` : "";
    return `${new Date(entry.time).toLocaleString(locale)} | ${areaName(entry.area)} | ${t(entry.message)}${repeated}${detail}`;
  });
  return [heading, ...lines].join("\n");
}

function Journal() {
  const { t, locale } = useT();
  const stored = useJournal((state) => state.entries);
  const toast = useUi((state) => state.toast);
  const newestFirst = [...stored].reverse();

  useEffect(() => {
    void loadJournal();
  }, []);

  const copy = async () => {
    try {
      const { version } = await getAppInfo();
      await navigator.clipboard.writeText(journalText(newestFirst, version, locale));
      toast(t("diagnostics.journal.copied"), "success");
    } catch {
      toast(t("diagnostics.journal.copyFailed"), "error");
    }
  };

  return (
    <section className="settings-group">
      <div className="journal__head">
        <h2>{t("diagnostics.journal")}</h2>
        {isDesktop && (
          <button className="text-button" onClick={() => void backend.openLogs().catch(() => toast(t("diagnostics.logs.failed"), "error"))}>
            <FolderOpen size={14} />
            {t("diagnostics.logs.open")}
          </button>
        )}
        {newestFirst.length > 0 && (
          <>
            <button className="text-button" onClick={() => void copy()}>
              <Copy size={14} />
              {t("diagnostics.journal.copy")}
            </button>
            <button className="text-button" onClick={clearJournal}>
              <Trash2 size={14} />
              {t("diagnostics.journal.clear")}
            </button>
          </>
        )}
      </div>
      {newestFirst.length === 0 ? (
        <p className="journal__empty">{t("diagnostics.journal.empty")}</p>
      ) : (
        <ul className="journal">
          {newestFirst.map((entry, index) => (
            // Counted from the oldest, so an entry keeps its key when newer ones arrive above it.
            <li key={newestFirst.length - index}>
              <time>{formatMoment(entry.time)}</time>
              <span className="tag">{areaName(entry.area)}</span>
              <div className="journal__text">
                <span>{t(entry.message)}</span>
                {entry.count > 1 && <em>{t("diagnostics.journal.repeated", { count: entry.count })}</em>}
                {entry.detail && <code>{entry.detail}</code>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function Diagnostics() {
  const { t } = useT();
  const { results, running, run } = useChecks();

  return (
    <div className="page page--narrow">
      <div className="page__head">
        <h1>{t("diagnostics.title")}</h1>
        <button className="button" disabled={running} onClick={run}>
          <RefreshCw size={16} className={running ? "spin" : ""} />
          {t("diagnostics.recheck")}
        </button>
      </div>
      <p className="diagnostics__lead">{t("diagnostics.lead")}</p>

      <section className="settings-group">
        <h2>{t("diagnostics.checks")}</h2>
        {checks.map((check) => (
          <CheckRow key={check.id} check={check} result={results[check.id]} />
        ))}
      </section>

      <Journal />
    </div>
  );
}
