import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, CalendarDays, Copy, Download, House, LayoutGrid, ListVideo, Minus, Search, Settings, Square, X } from "lucide-react";
import { isDesktop } from "../lib/backend";
import { useT } from "../lib/i18n";
import { useBrowse } from "../state/browse";
import { homeRefreshEvent, useUi } from "../state/ui";
import { InboxButton } from "./InboxButton";
import { isActiveDownload, useTorrents } from "../state/torrents";

const searchDebounceMs = 350;

async function appWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function WindowButtons() {
  const { t } = useT();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void appWindow().then(async (window) => {
      setMaximized(await window.isMaximized());
      const stop = await window.onResized(async () => setMaximized(await window.isMaximized()));
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!isDesktop) return null;
  return (
    <div className="window-buttons">
      <button aria-label={t("shell.window.minimize")} onClick={() => void appWindow().then((w) => w.minimize())}>
        <Minus size={16} />
      </button>
      <button
        aria-label={maximized ? t("shell.window.restore") : t("shell.window.maximize")}
        onClick={() => void appWindow().then((w) => w.toggleMaximize())}
      >
        {maximized ? <Copy size={13} /> : <Square size={12} />}
      </button>
      <button aria-label={t("common.close")} className="window-buttons__close" onClick={() => void appWindow().then((w) => w.close())}>
        <X size={16} />
      </button>
    </div>
  );
}

function SearchBox() {
  const { t } = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const onSearchPage = location.pathname === "/search";
  const [value, setValue] = useState(onSearchPage ? (params.get("q") ?? "") : "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!onSearchPage) setValue("");
  }, [onSearchPage]);

  useEffect(() => {
    const query = value.trim();
    if (!query) return;
    const timer = setTimeout(() => {
      navigate(`/search?q=${encodeURIComponent(query)}`, { replace: onSearchPage });
    }, searchDebounceMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      const withModifier = (event.ctrlKey || event.metaKey) && ["k", "f", "л", "а"].includes(event.key.toLowerCase());
      const slash = !typing && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "/" || event.key === ".") && event.code === "Slash";
      if ((withModifier || slash) && !useUi.getState().player) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (event.altKey && !typing && (event.key === "ArrowLeft" || event.key === "ArrowRight") && !useUi.getState().player) {
        event.preventDefault();
        if (event.key === "ArrowLeft") window.history.back();
        else window.history.forward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <label className="search-box">
      <Search size={16} />
      <input
        ref={inputRef}
        value={value}
        placeholder={t("shell.search.placeholder")}
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setValue("");
            event.currentTarget.blur();
          }
        }}
      />
      {value ? (
        <button aria-label={t("shell.search.clear")} onClick={() => setValue("")}>
          <X size={14} />
        </button>
      ) : (
        <kbd>Ctrl K</kbd>
      )}
    </label>
  );
}

export function Titlebar() {
  const { t } = useT();
  const navigate = useNavigate();
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar__brand" data-tauri-drag-region>
        <span className="brand-mark" />
        KINUZA
      </div>
      <div className="titlebar__history">
        <button aria-label={t("common.back")} onClick={() => navigate(-1)}>
          <ArrowLeft size={17} />
        </button>
        <button aria-label={t("common.forward")} onClick={() => navigate(1)}>
          <ArrowRight size={17} />
        </button>
      </div>
      <SearchBox />
      <div className="titlebar__spacer" data-tauri-drag-region />
      <InboxButton />
      <WindowButtons />
    </header>
  );
}

export function Sidebar() {
  const location = useLocation();
  const { t } = useT();
  const activeDownloads = useTorrents((state) => state.list.filter(isActiveDownload).length);
  const browseSearch = useBrowse((state) => state.search);

  return (
    <nav className="sidebar">
      <NavLink
        to="/"
        end
        className="sidebar__link"
        onClick={() => {
          if (location.pathname === "/") window.dispatchEvent(new Event(homeRefreshEvent));
        }}
      >
        <House size={21} />
        <span>{t("shell.nav.home")}</span>
      </NavLink>
      <NavLink to={{ pathname: "/browse", search: browseSearch }} className="sidebar__link">
        <LayoutGrid size={21} />
        <span>{t("browse.title")}</span>
      </NavLink>
      <NavLink to="/library" className="sidebar__link">
        <ListVideo size={21} />
        <span>{t("shell.nav.library")}</span>
      </NavLink>
      <NavLink to="/calendar" className="sidebar__link">
        <CalendarDays size={21} />
        <span>{t("shell.nav.calendar")}</span>
      </NavLink>
      <NavLink to="/downloads" className="sidebar__link">
        <Download size={21} />
        <span>{t("shell.nav.downloads")}</span>
        {activeDownloads > 0 && <em className="sidebar__badge">{activeDownloads}</em>}
      </NavLink>
      <div className="sidebar__gap" />
      <NavLink to="/settings" className="sidebar__link">
        <Settings size={21} />
        <span>{t("shell.nav.settings")}</span>
      </NavLink>
    </nav>
  );
}
