import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderOpen, RefreshCw } from "lucide-react";
import { HotkeyList } from "../components/HotkeyList";
import { ImportSetting } from "../components/ImportSetting";
import { TrackerAccount } from "../components/TrackerAccount";
import { LanguageSelect } from "../components/LanguagePicker";
import { backend, describeError, getAppInfo, isDesktop, isLinux } from "../lib/backend";
import { mpv } from "../lib/mpv";
import { accountDataVersion, describeAccountData, parseAccountData, type AccountData } from "../lib/account";
import { formatBytes } from "../lib/format";
import { useT, type MessageKey } from "../lib/i18n";
import { report } from "../lib/journal";
import { appLanguages, languageName } from "../lib/languages";
import { useAsync } from "../lib/useAsync";
import { useLibrary } from "../state/library";
import { useSettings, type AudioMode, type SpoilerMode, type SubtitleBackground, type SubtitleColor, type SubtitleFont, type VideoQuality } from "../state/settings";
import { accentColors } from "../lib/appearance";
import { useUi } from "../state/ui";
import { hasHistory, openHistory } from "../components/WhatsNew";
import { StorageBar, useStorageReport, useStorageTotals } from "../components/StorageBar";
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

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked ? "is-on" : ""}`} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

const backupMarker = "kinuza-backup";
const subtitlesOff = "off";

function NumberSetting({
  label,
  value,
  step = 1,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  max?: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <>
      <input
        className="input input--number"
        aria-label={label}
        type="number"
        min={0}
        max={max}
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
  const storageReport = useStorageReport(storage.data?.cacheBytes ?? 0);
  const storageTotals = useStorageTotals(storageReport.data);
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
  const languageLabel = (code: string) => {
    const name = languageName(code, locale);
    return name.charAt(0).toUpperCase() + name.slice(1);
  };

  const saveBackup = async () => {
    if (!isDesktop) return;
    try {
      const day = new Date().toISOString().slice(0, 10);
      const path = await backend.pickSaveTarget({
        title: t("settings.backup.save"),
        defaultName: `${t("settings.backup.fileName")} ${day}.json`,
        filterName: "JSON",
        extensions: ["json"],
      });
      if (!path) return;
      const { loaded: _loaded, load: _load, patch: _patch, ...currentSettings } = useSettings.getState();
      const backup = {
        app: backupMarker,
        createdAt: new Date().toISOString(),
        account: useLibrary.getState().exportAccountData(),
        settings: currentSettings,
      };
      await backend.writeTextFile(path, JSON.stringify(backup, null, 2));
      toast(t("settings.backup.saved"), "success");
    } catch (error) {
      toast(describeError(error), "error");
    }
  };

  const restoreBackup = async () => {
    if (!isDesktop) return;
    try {
      const picked = await backend.pickFile({ title: t("settings.backup.restore"), filterName: "JSON", extensions: ["json"] });
      if (!picked) return;
      const backup = JSON.parse(new TextDecoder().decode(await backend.readFileBytes(picked)));
      const parsed = backup?.app === backupMarker ? parseAccountData(backup.account) : null;
      if (!parsed) {
        toast(t("settings.backup.invalid"), "error");
        return;
      }
      if (parsed.data.version > accountDataVersion) {
        toast(t("settings.backup.newer"), "error");
        return;
      }
      confirmRestore(parsed.data, parsed.dropped, typeof backup.createdAt === "string" ? backup.createdAt : null, backup.settings);
    } catch {
      toast(t("settings.backup.invalid"), "error");
    }
  };

  const confirmRestore = (data: AccountData, dropped: number, createdAt: string | null, savedSettings: unknown) => {
    const incoming = describeAccountData(data);
    const current = describeAccountData(useLibrary.getState().exportAccountData());
    const date = createdAt ? new Date(createdAt).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" }) : null;
    const restore = async (mode: "merge" | "replace") => {
      try {
        await useLibrary.getState().restoreAccountData(data, mode);
        if (mode === "replace" && savedSettings && typeof savedSettings === "object") {
          const { downloadDir: _downloadDir, handleLinks: _handleLinks, linksPrompted: _linksPrompted, ...portable } = savedSettings as Record<string, unknown>;
          settings.patch(portable as Partial<typeof settings>);
        }
        toast(t(mode === "replace" ? "settings.backup.replaced" : "settings.backup.restored"), "success");
      } catch (error) {
        toast(describeError(error), "error");
      }
    };
    useUi.getState().askConfirm({
      title: date ? t("settings.backup.confirm.titleDated", { date }) : t("settings.backup.confirm.title"),
      message: [
        t("settings.backup.confirm.incoming", { titles: incoming.titles, rated: incoming.rated, episodes: incoming.episodes }),
        t("settings.backup.confirm.current", { titles: current.titles, rated: current.rated, episodes: current.episodes }),
        dropped > 0 ? t("settings.backup.confirm.dropped", { count: dropped }) : "",
        t("settings.backup.confirm.modes"),
      ]
        .filter(Boolean)
        .join("\n\n"),
      secondaryLabel: t("settings.backup.merge"),
      onSecondary: () => void restore("merge"),
      confirmLabel: t("settings.backup.replace"),
      danger: true,
      onConfirm: () => void restore("replace"),
    });
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

  const pageRef = useRef<HTMLDivElement>(null);
  const showSection = (id: string) =>
    pageRef.current?.querySelector<HTMLElement>(`[data-section="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const sections: { id: string; label: MessageKey }[] = [
    { id: "settings-viewing", label: "settings.viewing" },
    { id: "settings-look", label: "settings.look" },
    { id: "settings-downloads", label: "settings.downloads" },
    { id: "settings-system", label: "settings.system" },
    { id: "settings-accounts", label: "settings.accounts" },
    { id: "settings-data", label: "settings.data" },
    { id: "settings-help", label: "settings.help" },
  ];

  return (
    <div className="page page--narrow" ref={pageRef}>
      <div className="page__head">
        <h1>{t("settings.title")}</h1>
      </div>

      <nav className="settings-nav" aria-label={t("settings.sections")}>
        {sections.map((section) => (
          <button key={section.id} className="chip" onClick={() => showSection(section.id)}>
            {t(section.label)}
          </button>
        ))}
      </nav>

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

      <section className="settings-group" data-section="settings-viewing">
        <h2>{t("settings.viewing")}</h2>
        <div className="setting">
          <div>
            <strong>{t("settings.viewing.audio")}</strong>
            <p>{t("settings.viewing.audio.note")}</p>
          </div>
          <div className="setting__actions">
            <select
              className="select select--large"
              aria-label={t("settings.viewing.audio")}
              value={settings.audioLanguage}
              onChange={(event) => settings.patch({ audioLanguage: event.target.value })}
            >
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
            <select
              className="select select--large"
              aria-label={t("settings.viewing.subtitles")}
              value={settings.subtitleLanguage}
              onChange={(event) => settings.patch({ subtitleLanguage: event.target.value })}
            >
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
        <div className="setting">
          <div>
            <strong>{t("settings.player.quality")}</strong>
            <p>{t("settings.player.quality.note")}</p>
          </div>
          <select
            className="select select--large"
            aria-label={t("settings.player.quality")}
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
          <Toggle label={t("settings.player.autoNext")} checked={settings.autoNextEpisode} onChange={(value) => settings.patch({ autoNextEpisode: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.player.soundSegments")}</strong>
            <p>{t("settings.player.soundSegments.note")}</p>
          </div>
          <Toggle label={t("settings.player.soundSegments")} checked={settings.soundSegments} onChange={(value) => settings.patch({ soundSegments: value })} />
        </div>
        {mpv.smoothMotion && (
          <div className="setting">
            <div>
              <strong>{t("settings.player.smooth")}</strong>
              <p>{t("settings.player.smooth.note")}</p>
            </div>
            <Toggle label={t("settings.player.smooth")} checked={settings.smoothMotion} onChange={(value) => settings.patch({ smoothMotion: value })} />
          </div>
        )}
        {mpv.supported && (
          <div className="setting">
            <div>
              <strong>{t("settings.player.picture")}</strong>
              <p>{t("settings.player.picture.note")}</p>
            </div>
            <select
              className="select select--large"
              aria-label={t("settings.player.picture")}
              value={settings.videoQuality}
              onChange={(event) => settings.patch({ videoQuality: event.target.value as VideoQuality })}
            >
              <option value="high">{t("settings.player.picture.high")}</option>
              <option value="balanced">{t("settings.player.picture.balanced")}</option>
              <option value="fast">{t("settings.player.picture.fast")}</option>
            </select>
          </div>
        )}
        {mpv.supported && (
          <div className="setting">
            <div>
              <strong>{t("settings.player.autoSimplify")}</strong>
              <p>{t("settings.player.autoSimplify.note")}</p>
            </div>
            <Toggle label={t("settings.player.autoSimplify")} checked={settings.autoSimplify} onChange={(value) => settings.patch({ autoSimplify: value })} />
          </div>
        )}
        <div className="setting">
          <div>
            <strong>{t("player.audio.mode")}</strong>
            <p>{t("settings.player.audioMode.note")}</p>
          </div>
          <select
            className="select select--large"
            aria-label={t("player.audio.mode")}
            value={settings.audioMode}
            onChange={(event) => settings.patch({ audioMode: event.target.value as AudioMode })}
          >
            {(["off", "night", "level", "dialogue"] as const).map((mode) => (
              <option key={mode} value={mode}>
                {t(`player.audio.mode.${mode}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.subtitles.look")}</strong>
            <p>{t("settings.subtitles.look.note")}</p>
          </div>
          <div className="setting__actions setting__actions--wrap">
            <select
              className="select"
              aria-label={t("settings.subtitles.font")}
              value={settings.subtitleFont}
              onChange={(event) => settings.patch({ subtitleFont: event.target.value as SubtitleFont })}
            >
              {(["sans", "serif", "rounded", "condensed"] as const).map((font) => (
                <option key={font} value={font}>
                  {t(`settings.subtitles.font.${font}`)}
                </option>
              ))}
            </select>
            <select
              className="select"
              aria-label={t("settings.subtitles.background")}
              value={settings.subtitleBackground}
              onChange={(event) => settings.patch({ subtitleBackground: event.target.value as SubtitleBackground })}
            >
              {(["outline", "shadow", "box"] as const).map((background) => (
                <option key={background} value={background}>
                  {t(`player.subtitles.background.${background}`)}
                </option>
              ))}
            </select>
            <select
              className="select"
              aria-label={t("settings.subtitles.color")}
              value={settings.subtitleColor}
              onChange={(event) => settings.patch({ subtitleColor: event.target.value as SubtitleColor })}
            >
              {(["white", "yellow", "cyan", "green"] as const).map((color) => (
                <option key={color} value={color}>
                  {t(`player.subtitles.color.${color}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.subtitles.position")}</strong>
            <p>{t("settings.subtitles.position.note")}</p>
          </div>
          <NumberSetting
            label={t("settings.subtitles.position")}
            value={settings.subtitlePosition}
            step={2}
            max={30}
            unit="%"
            onChange={(value) => settings.patch({ subtitlePosition: Math.min(30, Math.max(0, value)) })}
          />
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
        <details className="setting setting--details">
          <summary>
            <strong>{t("settings.hotkeys")}</strong>
            <p>{t("settings.hotkeys.note")}</p>
          </summary>
          <HotkeyList />
        </details>
      </section>

      <section className="settings-group" data-section="settings-look">
        <h2>{t("settings.look")}</h2>
        <div className="setting">
          <div>
            <strong>{t("settings.look.density")}</strong>
            <p>{t("settings.look.density.note")}</p>
          </div>
          <div className="setting__actions">
            {(["compact", "normal", "large"] as const).map((density) => (
              <button
                key={density}
                className={`chip ${settings.gridDensity === density ? "is-active" : ""}`}
                aria-pressed={settings.gridDensity === density}
                onClick={() => settings.patch({ gridDensity: density })}
              >
                {t(`settings.look.density.${density}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.look.accent")}</strong>
            <p>{t("settings.look.accent.note")}</p>
          </div>
          <div className="setting__actions accent-picker" role="radiogroup" aria-label={t("settings.look.accent")}>
            {accentColors.map((item) => (
              <button
                key={item.id || "default"}
                role="radio"
                aria-checked={settings.accent === item.id}
                aria-label={t(`settings.look.accent.${item.id || "red"}` as MessageKey)}
                title={t(`settings.look.accent.${item.id || "red"}` as MessageKey)}
                className={`accent-picker__swatch ${settings.accent === item.id ? "is-active" : ""}`}
                style={{ "--swatch": item.color } as React.CSSProperties}
                onClick={() => settings.patch({ accent: item.id })}
              />
            ))}
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.spoilers")}</strong>
            <p>{t("settings.spoilers.note")}</p>
          </div>
          <select
            className="select select--large"
            aria-label={t("settings.spoilers")}
            value={settings.spoilerDescriptions}
            onChange={(event) => settings.patch({ spoilerDescriptions: event.target.value as SpoilerMode })}
          >
            <option value="blur">{t("settings.spoilers.blur")}</option>
            <option value="hide">{t("settings.spoilers.hide")}</option>
            <option value="show">{t("settings.spoilers.show")}</option>
          </select>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.spoilers.stills")}</strong>
            <p>{t("settings.spoilers.stills.note")}</p>
          </div>
          <Toggle label={t("settings.spoilers.stills")} checked={settings.spoilerStills} onChange={(value) => settings.patch({ spoilerStills: value })} />
        </div>
      </section>

      <section className="settings-group" data-section="settings-downloads">
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
        <div className="setting setting--storage">
          <div className="setting__wide">
            <div className="setting__wide-head">
              <div>
                <strong>{t("settings.storage")}</strong>
                <p>{t("settings.storage.note")}</p>
              </div>
              <button className="button" onClick={() => navigate("/storage")}>
                {t("settings.storage.manage")}
              </button>
            </div>
            {storageTotals ? <StorageBar totals={storageTotals} /> : <p>…</p>}
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
            <NumberSetting label={t("settings.cache")} value={settings.cacheLimitGb} step={5} unit={t("settings.cache.unit")} onChange={(value) => settings.patch({ cacheLimitGb: value })} />
          </div>
        </div>
        {isDesktop && info.data && info.data.listenPort > 0 && (
          <div className="setting">
            <div>
              <strong>{t("settings.port")}</strong>
              <p>{t("settings.port.note", { port: info.data.listenPort })}</p>
            </div>
          </div>
        )}
        <div className="setting">
          <div>
            <strong>{t("settings.autoDelete")}</strong>
            <p>{t("settings.autoDelete.note")}</p>
          </div>
          <Toggle label={t("settings.autoDelete")} checked={settings.autoDeleteWatched} onChange={(value) => settings.patch({ autoDeleteWatched: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.autoAddEpisodes")}</strong>
            <p>{t("settings.autoAddEpisodes.note")}</p>
          </div>
          <Toggle label={t("settings.autoAddEpisodes")} checked={settings.autoAddEpisodes} onChange={(value) => settings.patch({ autoAddEpisodes: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.limits.download")}</strong>
            <p>{t("settings.limits.note")}</p>
          </div>
          <div className="setting__actions">
            <NumberSetting label={t("settings.limits.download")} value={settings.downloadLimit} step={100} unit={t("settings.limits.unit")} onChange={(value) => settings.patch({ downloadLimit: value })} />
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.uploadByDefault")}</strong>
            <p>{t("settings.uploadByDefault.note")}</p>
          </div>
          <Toggle label={t("settings.uploadByDefault")} checked={settings.uploadByDefault} onChange={(value) => settings.patch({ uploadByDefault: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.limits.upload")}</strong>
            <p>{t("settings.limits.note")}</p>
          </div>
          <div className="setting__actions">
            <NumberSetting label={t("settings.limits.upload")} value={settings.uploadLimit} step={100} unit={t("settings.limits.unit")} onChange={(value) => settings.patch({ uploadLimit: value })} />
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.queue")}</strong>
            <p>{t("settings.queue.note")}</p>
          </div>
          <div className="setting__actions">
            <NumberSetting label={t("settings.queue")} value={settings.maxActiveDownloads} onChange={(value) => settings.patch({ maxActiveDownloads: Math.round(value) })} />
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.seeding")}</strong>
            <p>{t("settings.seeding.note")}</p>
          </div>
          <div className="setting__actions">
            <NumberSetting label={t("settings.seeding")} value={settings.seedRatio} step={0.5} unit="×" onChange={(value) => settings.patch({ seedRatio: value })} />
          </div>
        </div>
      </section>

      <section className="settings-group" data-section="settings-system">
        <h2>{t("settings.system")}</h2>
        <div className="setting">
          <div>
            <strong>{t("settings.notify")}</strong>
            <p>{t("settings.notify.note")}</p>
          </div>
          <Toggle label={t("settings.notify")} checked={settings.notifyDownloads} onChange={(value) => settings.patch({ notifyDownloads: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.notifyEpisodes")}</strong>
            <p>{t("settings.notifyEpisodes.note")}</p>
          </div>
          <Toggle label={t("settings.notifyEpisodes")} checked={settings.notifyEpisodes} onChange={(value) => settings.patch({ notifyEpisodes: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.tray")}</strong>
            <p>{t(isLinux ? "settings.tray.note.linux" : "settings.tray.note")}</p>
          </div>
          <Toggle label={t("settings.tray")} checked={settings.closeToTray} onChange={(value) => settings.patch({ closeToTray: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>{t("settings.links.open")}</strong>
            <p>{t("settings.links.open.note")}</p>
          </div>
          <Toggle label={t("settings.links.open")} checked={settings.handleLinks} onChange={(value) => void toggleLinks(value)} />
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
        <div className="setting">
          <div>
            <strong>{t("settings.updates.version", { version: info.data?.version ?? "…" })}</strong>
            <p>{updateLabel ? t(updateLabel) : t("settings.updates.note")}</p>
          </div>
          <div className="setting__actions">
            {info.data && hasHistory(info.data.version) && (
              <button className="button" onClick={() => info.data && openHistory(info.data.version)}>
                {t("whatsNew.open")}
              </button>
            )}
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
          <Toggle label={t("settings.updates.auto")} checked={settings.autoUpdate} onChange={(value) => settings.patch({ autoUpdate: value })} />
        </div>
      </section>

      <section className="settings-group" data-section="settings-accounts">
        <h2>{t("settings.accounts")}</h2>
        <TrackerAccount />
      </section>

      <section className="settings-group" data-section="settings-data">
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
        <div className="setting setting--stack">
          <div>
            <strong>{t("settings.catalog.key")}</strong>
            <p>{t("settings.catalog.key.note")}</p>
          </div>
          <div className="setting__row">
            <input
              className="input"
              aria-label={t("settings.catalog.key")}
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

      <section className="settings-group" data-section="settings-help">
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
