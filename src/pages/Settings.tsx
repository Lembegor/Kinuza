import { useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import { backend, describeError, getAppInfo, isDesktop } from "../lib/backend";
import { useAsync } from "../lib/useAsync";
import { useSettings } from "../state/settings";
import { useUi } from "../state/ui";
import { useUpdater, type UpdateStatus } from "../state/updater";

const updateLabels: Record<UpdateStatus, string> = {
  idle: "",
  checking: "Проверяем…",
  upToDate: "У вас последняя версия.",
  available: "Доступна новая версия.",
  downloading: "Скачиваем обновление…",
  installing: "Устанавливаем…",
  error: "Не удалось проверить обновления.",
};

const qualityOptions = [
  { value: 0, label: "Максимальное" },
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

export default function Settings() {
  const settings = useSettings();
  const updater = useUpdater();
  const info = useAsync(getAppInfo, []);
  const [keyDraft, setKeyDraft] = useState(settings.tmdbKey);
  const associations = useAsync(backend.associationStatus, [settings.handleLinks]);

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
    const picked = await open({ directory: true, title: "Папка для загрузок" });
    if (typeof picked === "string") settings.patch({ downloadDir: picked });
  };

  return (
    <div className="page page--narrow">
      <div className="page__head">
        <h1>Настройки</h1>
      </div>

      <section className="settings-group">
        <h2>Загрузки</h2>
        <div className="setting">
          <div>
            <strong>Папка для файлов</strong>
            <p>{settings.downloadDir || info.data?.defaultDownloadDir || "…"}</p>
          </div>
          <div className="setting__actions">
            {settings.downloadDir && (
              <button className="button" onClick={() => settings.patch({ downloadDir: "" })}>
                Сбросить
              </button>
            )}
            <button className="button" onClick={() => void chooseFolder()}>
              <FolderOpen size={16} />
              Выбрать
            </button>
          </div>
        </div>
        <p className="settings-group__note">Новая папка действует для торрентов, добавленных после смены.</p>
      </section>

      <section className="settings-group">
        <h2>Ссылки из браузера</h2>
        <div className="setting">
          <div>
            <strong>Открывать торренты в Kinuza</strong>
            <p>
              Нажатие на magnet-ссылку в браузере или на .torrent-файл открывает Kinuza с готовым диалогом добавления.
            </p>
          </div>
          <Toggle checked={settings.handleLinks} onChange={(value) => void toggleLinks(value)} />
        </div>
        {settings.handleLinks && associations.data?.overriddenByWindows && (
          <div className="setting">
            <div>
              <strong>В Windows выбрана другая программа</strong>
              <p>
                Раньше для торрентов вручную была выбрана другая программа, и Windows использует её. Выберите Kinuza для
                «MAGNET» и «.torrent» в параметрах.
              </p>
            </div>
            <div className="setting__actions">
              <button className="button" onClick={() => void backend.openDefaultAppsSettings()}>
                Параметры Windows
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="settings-group">
        <h2>Плеер</h2>
        <div className="setting">
          <div>
            <strong>Качество по умолчанию</strong>
            <p>
              С какого качества начинать, когда у фильма или серии добавлено несколько источников. В плеере его можно
              переключить в любой момент.
            </p>
          </div>
          <select
            className="select select--large"
            value={settings.preferredQuality}
            onChange={(event) => settings.patch({ preferredQuality: Number(event.target.value) })}
          >
            {qualityOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="setting">
          <div>
            <strong>Следующая серия автоматически</strong>
            <p>После конца серии запускать следующую, если для неё есть источник.</p>
          </div>
          <Toggle checked={settings.autoNextEpisode} onChange={(value) => settings.patch({ autoNextEpisode: value })} />
        </div>
        <div className="setting">
          <div>
            <strong>Внешний плеер</strong>
            <p>
              {info.data?.externalPlayer
                ? `Найден ${info.data.externalPlayer}. Через него открываются файлы, которые встроенный плеер не воспроизводит.`
                : "Не найден. Для редких форматов звука и видео установите VLC или mpv."}
            </p>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h2>Обновления</h2>
        <div className="setting">
          <div>
            <strong>Версия {info.data?.version ?? "…"}</strong>
            <p>{updateLabels[updater.status] || "Приложение обновляется само: скачивает новую версию и перезапускается."}</p>
          </div>
          <div className="setting__actions">
            {updater.status === "available" ? (
              <button className="button button--primary" onClick={() => void updater.install()}>
                Обновить до {updater.version}
              </button>
            ) : (
              <button className="button" disabled={!isDesktop || updater.status === "checking"} onClick={() => void updater.check()}>
                <RefreshCw size={16} className={updater.status === "checking" ? "spin" : ""} />
                Проверить
              </button>
            )}
          </div>
        </div>
        <div className="setting">
          <div>
            <strong>Проверять при запуске</strong>
            <p>Сообщать о новой версии, когда приложение открывается.</p>
          </div>
          <Toggle checked={settings.autoUpdate} onChange={(value) => settings.patch({ autoUpdate: value })} />
        </div>
      </section>

      <section className="settings-group">
        <h2>Каталог</h2>
        <div className="setting setting--stack">
          <div>
            <strong>Свой ключ TMDB</strong>
            <p>Необязательно. Оставьте пустым, чтобы использовать ключ, встроенный в приложение.</p>
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
              Сохранить
            </button>
          </div>
        </div>
        <p className="settings-group__note">
          Постеры, описания и списки серий предоставлены TMDB. This product uses the TMDB API but is not endorsed or
          certified by TMDB.
        </p>
      </section>
    </div>
  );
}
