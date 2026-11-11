import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderOpen, RefreshCw } from "lucide-react";
import { ImportSetting } from "../components/ImportSetting";
import { LanguageSelect } from "../components/LanguagePicker";
import { backend, describeError, getAppInfo, isDesktop } from "../lib/backend";
import { accountDataVersion } from "../lib/account";
import { formatBytes } from "../lib/format";
import { useT, type MessageKey } from "../lib/i18n";
import { report } from "../lib/journal";
import { appLanguages, languageName } from "../lib/languages";
import { useAsync } from "../lib/useAsync";
import { useLibrary } from "../state/library";
import { useSettings } from "../state/settings";
import { isDownload, useTorrents } from "../state/torrents";
import { useUi } from "../state/ui";
import { useUpdater, type UpdateStatus } from "../state/updater";

const updateLabels: Record<UpdateStatus, MessageKey | null> = {
  idle: null,
  checking: "settings.updates.status.checking",
  upToDate: "settings.updates.status.upToDate",
  available: "settings.updates.status.available",
  downloading: "settings.updates.status.downloading",
  installing: "settings.updates.status.installing",
  error: "settings.updates.status.error",
};

const bestQuality = 0;

const qualityOptions = [
  { value: 2160, label: "2160p (4K)" },
  { value: 1080, label: "1080p" },
  { value: 720, label: "720p" },
  { value: 480, label: "480p" },
];

function Toggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} className={`toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

const backupMarker = "kinuza-backup";
const subtitlesOff = "off";

function NumberSetting({ value, step = 1, unit, onChange }: { value: number; step?: number; unit?: string; onChange: (value: number) => void }) {
  return (
    <>
      <input
        className="input input--number"
        type="number"
        min={0}
        step={step}
        value={value}
        onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))}
      />
      {unit && <span className="setting__unit">{unit}</span>}
    </>
  );
}

export default function Settings() {
  const settings = useSettings();
  const { t, locale } = useT();
  const navigate = useNavigate();
  const toast = useUi((state) => state.toast);
  const storage = useAsync(() => backend.storageInfo(settings.downloadDir || null), [settings.downloadDir]);
  const [clearingCache, setClearingCache] = useState(false);
  const clearCache = async () => {
    setClearingCache(true);
    try {
      const freed = await backend.clearStreamCache();
      toast(t("settings.cache.cleared", { size: formatBytes(freed) }), "success");
      storage.reload();
    } catch (error) {
      report("downloads", "journal.cache.clear", error);
      toast(t("settings.cache.clearFailed"), "error");
    } finally {
      setClearingCache(false);
    }
  };
  const downloadedBytes = useTorrents((state) =>
    state.list.filter(isDownload).reduce((sum, torrent) => sum + torrent.files.reduce((files, file) => files + file.downloaded, 0), 0),
  );
  const languageLabel = (code: string) => {
    const name = languageName(code, locale);
    return name.charAt(0).toUpperCase() + name.slice(1);
  };

  const saveBackup = async () => {
    if (!isDesktop) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const day = new Date().toISOString().slice(0, 10);
      const path = await save({
        title: t("settings.backup.save"),
        defaultPath: `${t("settings.backup.fileName")} ${day}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const backup = { app: backupMarker, account: useLibrary.getState().exportAccountData() };
      await backend.writeTextFile(path, JSON.stringify(backup, null, 2));
      toast(t("settings.backup.saved"), "success");
    } catch (error) {
      toast(describeError(error), "error");
    }
  };

  const restoreBackup = async () => {
    if (!isDesktop) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ title: t("settings.backup.restore"), filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof picked !== "string") return;
      const backup = JSON.parse(new TextDecoder().decode(await backend.readFileBytes(picked)));
      const account = backup?.app === backupMarker ? backup.account : null;
      if (!account || typeof account.tracked !== "object" || typeof account.progress !== "object") {
        toast(t("settings.backup.invalid"), "error");
        return;
      }
      useLibrary.getState().mergeAccountData({
        version: accountDataVersion,
        tracked: account.tracked,
        progress: account.progress,
        removed: account.removed ?? {},
        preferences: account.preferences ?? {},
        dismissed: typeof account.dismissed === "object" && account.dismissed !== null ? account.dismissed : undefined,
        onboardedAt: typeof account.onboardedAt === "number" ? account.onboardedAt : undefined,
      });
      toast(t("settings.backup.restored"), "success");
    } catch {
      toast(t("settings.backup.invalid"), "error");
    }
  };
  const updater = useUpdater();
  const info = useAsync(getAppInfo, []);
  const [keyDraft, setKeyDraft] = useState(settings.tmdbKey);
  const associations = useAsync(backend.associationStatus, [settings.handleLinks]);
  const updateLabel = updateLabels[updater.status];

  const toggleLinks = async (enabled: boolean) => {
    try {
      await backend.setAssociations(enabled);
      settings.patch({ handleLinks: enabled, linksPrompted: true });
    } catch (error) {
      useUi.getState().toast(describeError(error), "error");
    }
  };

  const chooseFolder = async () => {
    if (!isDesktop) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, title: t("settings.downloads.folder.dialog") });
    if (typeof picked === "string") settings.patch({ downloadDir: picked });
  };

  return (
    <div className="page page--narrow">
      <div className="page__head">
        <h1>{t("settings.title")}</h1>
      </div>

      <section className="settings-group">
        <div className="setting">
          <div>
            <strong>{t("settings.language")}</strong>
            <p>{t("settings.language.note")}</p>
          </div>
          <div className="setting__actions">
            <LanguageSelect />
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2>{t("settings.downloads")}</h2>
        <div className="setting">
          <div>
            <strong>{t("settings.downloads.folder")}</strong>
            <p>{settings.downloadDir || info.data?.defaultDownloadDir || "…"}</p>
            <p>{t("settings.downloads.note")}</p>
          </div>
          <div className="setting__actions">
            {settings.downloadDir && (
              <button className="button" onClick={() => settings.patch({ downloadDir: "" })}>
                {t("settings.reset")}
              </button>
            )}
            <button className="button" onClick={() => void chooseFolder()}>
              <FolderOpen size={16} />
              {t("settings.choose")}
            </button>
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.storage")}</strong>
            <p>
              {storage.data
                ? t("settings.storage.value", {
                    free: formatBytes(storage.data.freeBytes),
                    total: formatBytes(storage.data.totalBytes),
                    used: formatBytes(downloadedBytes),
                  })
                : "…"}
            </p>
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.cache")}</strong>
            <p>
              {t("settings.cache.note")}
              {storage.data && storage.data.cacheBytes > 0 && <> {t("settings.cache.used", { size: formatBytes(storage.data.cacheBytes) })}</>}
            </p>
          </div>
          <div className="setting__actions">
            {storage.data && storage.data.cacheBytes > 0 && (
              <button className="button" disabled={clearingCache} onClick={() => void clearCache()}>
                {t("settings.cache.clear")}
              </button>
            )}
            <NumberSetting value={settings.cacheLimitGb} step={5} unit={t("settings.cache.unit")} onChange={(value) => settings.patch({ cacheLimitGb: value })} />
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.autoDelete")}</strong>
            <p>{t("settings.autoDelete.note")}</p>
          </div>
          <Toggle checked={settings.autoDeleteWatched} onChange={(value) => settings.patch({ autoDeleteWatched: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.tray")}</strong>
            <p>{t("settings.tray.note")}</p>
          </div>
          <Toggle checked={settings.closeToTray} onChange={(value) => settings.patch({ closeToTray: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.notify")}</strong>
            <p>{t("settings.notify.note")}</p>
          </div>
          <Toggle checked={settings.notifyDownloads} onChange={(value) => settings.patch({ notifyDownloads: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.notifyEpisodes")}</strong>
            <p>{t("settings.notifyEpisodes.note")}</p>
          </div>
          <Toggle checked={settings.notifyEpisodes} onChange={(value) => settings.patch({ notifyEpisodes: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.autoAddEpisodes")}</strong>
            <p>{t("settings.autoAddEpisodes.note")}</p>
          </div>
          <Toggle checked={settings.autoAddEpisodes} onChange={(value) => settings.patch({ autoAddEpisodes: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.limits.download")}</strong>
            <p>{t("settings.limits.note")}</p>
          </div>
          <div className="setting__actions">
            <NumberSetting value={settings.downloadLimit} step={100} unit={t("settings.limits.unit")} onChange={(value) => settings.patch({ downloadLimit: value })} />
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.limits.upload")}</strong>
            <p>{t("settings.limits.note")}</p>
          </div>
          <div className="setting__actions">
            <NumberSetting value={settings.uploadLimit} step={100} unit={t("settings.limits.unit")} onChange={(value) => settings.patch({ uploadLimit: value })} />
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.queue")}</strong>
            <p>{t("settings.queue.note")}</p>
          </div>
          <div className="setting__actions">
            <NumberSetting value={settings.maxActiveDownloads} onChange={(value) => settings.patch({ maxActiveDownloads: Math.round(value) })} />
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.seeding")}</strong>
            <p>{t("settings.seeding.note")}</p>
          </div>
          <div className="setting__actions">
            <NumberSetting value={settings.seedRatio} step={0.5} unit="×" onChange={(value) => settings.patch({ seedRatio: value })} />
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2>{t("settings.viewing")}</h2>
        <div className="setting">
          <div>
            <strong>{t("settings.viewing.audio")}</strong>
            <p>{t("settings.viewing.audio.note")}</p>
          </div>
          <div className="setting__actions">
            <select className="select select--large" value={settings.audioLanguage} onChange={(event) => settings.patch({ audioLanguage: event.target.value })}>
              <option value="">{t("settings.viewing.audio.original")}</option>
              {appLanguages.map((code) => (
                <option key={code} value={code}>
                  {languageLabel(code)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.viewing.subtitles")}</strong>
            <p>{t("settings.viewing.subtitles.note")}</p>
          </div>
          <div className="setting__actions">
            <select className="select select--large" value={settings.subtitleLanguage} onChange={(event) => settings.patch({ subtitleLanguage: event.target.value })}>
              <option value="">{t("settings.viewing.subtitles.interface")}</option>
              <option value={subtitlesOff}>{t("settings.viewing.subtitles.off")}</option>
              {appLanguages.map((code) => (
                <option key={code} value={code}>
                  {languageLabel(code)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2>{t("settings.data")}</h2>
        <div className="setting">
          <div>
            <strong>{t("settings.backup")}</strong>
            <p>{t("settings.backup.note")}</p>
          </div>
          <div className="setting__actions">
            <button className="button" onClick={() => void restoreBackup()}>
              {t("settings.backup.restore")}
            </button>
            <button className="button" onClick={() => void saveBackup()}>
              {t("settings.backup.save")}
            </button>
          </div>
        </div>
        <ImportSetting />
      </section>

      <section className="settings-group">
        <h2>{t("settings.links")}</h2>
        <div className="setting">
          <div>
            <strong>{t("settings.links.open")}</strong>
            <p>{t("settings.links.open.note")}</p>
          </div>
          <Toggle checked={settings.handleLinks} onChange={(value) => void toggleLinks(value)} />
        </div>
        {settings.handleLinks && associations.data?.overriddenByWindows && (
          <div className="setting">
            <div>
              <strong>{t("settings.links.overridden")}</strong>
              <p>{t("settings.links.overridden.note")}</p>
            </div>
            <div className="setting__actions">
              <button className="button" onClick={() => void backend.openDefaultAppsSettings()}>
                {t("settings.links.windowsSettings")}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="settings-group">
        <h2>{t("settings.player")}</h2>
        <div className="setting">
          <div>
            <strong>{t("settings.player.quality")}</strong>
            <p>{t("settings.player.quality.note")}</p>
          </div>
          <select
            className="select select--large"
            value={settings.preferredQuality}
            onChange={(event) => settings.patch({ preferredQuality: Number(event.target.value) })}
          >
            <option value={bestQuality}>{t("settings.player.quality.max")}</option>
            {qualityOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.player.autoNext")}</strong>
            <p>{t("settings.player.autoNext.note")}</p>
          </div>
          <Toggle checked={settings.autoNextEpisode} onChange={(value) => settings.patch({ autoNextEpisode: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.player.external")}</strong>
            <p>
              {info.data?.externalPlayer
                ? t("settings.player.external.found", { player: info.data.externalPlayer })
                : t("settings.player.external.missing")}
            </p>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2>{t("settings.updates")}</h2>
        <div className="setting">
          <div>
            <strong>{t("settings.updates.version", { version: info.data?.version ?? "…" })}</strong>
            <p>{updateLabel ? t(updateLabel) : t("settings.updates.note")}</p>
          </div>
          <div className="setting__actions">
            {updater.status === "available" ? (
              <button className="button button--primary" onClick={() => void updater.install()}>
                {t("settings.updates.install", { version: updater.version })}
              </button>
            ) : (
              <button className="button" disabled={!isDesktop || updater.status === "checking"} onClick={() => void updater.check()}>
                <RefreshCw size={16} className={updater.status === "checking" ? "spin" : ""} />
                {t("settings.updates.check")}
              </button>
            )}
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.updates.auto")}</strong>
            <p>{t("settings.updates.auto.note")}</p>
          </div>
          <Toggle checked={settings.autoUpdate} onChange={(value) => settings.patch({ autoUpdate: value })} />
        </div>
      </section>

      <section className="settings-group">
        <h2>{t("settings.catalog")}</h2>
        <div className="setting setting--stack">
          <div>
            <strong>{t("settings.catalog.key")}</strong>
            <p>{t("settings.catalog.key.note")}</p>
          </div>
          <div className="setting__row">
            <input
              className="input"
              value={keyDraft}
              placeholder="API Key (v3 auth)"
              spellCheck={false}
              onChange={(event) => setKeyDraft(event.target.value)}
            />
            <button className="button" disabled={keyDraft.trim() === settings.tmdbKey} onClick={() => settings.patch({ tmdbKey: keyDraft.trim() })}>
              {t("settings.save")}
            </button>
          </div>
        </div>
        <p className="settings-group__note">
          {t("settings.catalog.credit")} This product uses the TMDB API but is not endorsed or certified by TMDB.
        </p>
      </section>

      <section className="settings-group">
        <h2>{t("settings.help")}</h2>
        <div className="setting">
          <div>
            <strong>{t("diagnostics.title")}</strong>
            <p>{t("settings.diagnostics.note")}</p>
          </div>
          <div className="setting__actions">
            <button className="button" onClick={() => navigate("/diagnostics")}>
              {t("settings.diagnostics.open")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
