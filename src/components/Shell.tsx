// Window chrome: title bar with search and window buttons, side navigation.

import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, Bookmark, Copy, Download, House, Minus, Search, Settings, Square, X } from "lucide-react";
import { isDesktop } from "../lib/backend";
import { useTorrents } from "../state/torrents";

const searchDebounceMs = 350;

async function appWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function WindowButtons() {
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
      <button aria-label="Свернуть" onClick={() => void appWindow().then((w) => w.minimize())}>
        <Minus size={16} />
      </button>
      <button
        aria-label={maximized ? "Восстановить" : "Развернуть"}
        onClick={() => void appWindow().then((w) => w.toggleMaximize())}
      >
        {maximized ? <Copy size={13} /> : <Square size={12} />}
      </button>
      <button aria-label="Закрыть" className="window-buttons__close" onClick={() => void appWindow().then((w) => w.close())}>
        <X size={16} />
      </button>
    </div>
  );
}

function SearchBox() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const onSearchPage = location.pathname === "/search";
  const [value, setValue] = useState(onSearchPage ? (params.get("q") ?? "") : "");
  const inputRef = useRef<HTMLInputElement>(null);

  // Leaving the search page clears the box so it never shows a stale query.
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
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
        placeholder="Фильмы, сериалы, аниме"
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
        <button aria-label="Очистить" onClick={() => setValue("")}>
          <X size={14} />
        </button>
      ) : (
        <kbd>Ctrl K</kbd>
      )}
    </label>
  );
}

export function Titlebar() {
  const navigate = useNavigate();
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar__brand" data-tauri-drag-region>
        <span className="brand-mark" />
        KINUZA
      </div>
      <div className="titlebar__history">
        <button aria-label="Назад" onClick={() => navigate(-1)}>
          <ArrowLeft size={17} />
        </button>
        <button aria-label="Вперёд" onClick={() => navigate(1)}>
          <ArrowRight size={17} />
        </button>
      </div>
      <SearchBox />
      <div className="titlebar__spacer" data-tauri-drag-region />
      <WindowButtons />
    </header>
  );
}

export function Sidebar() {
  const activeDownloads = useTorrents(
    (state) => state.list.filter((torrent) => !torrent.finished && torrent.state !== "paused").length,
  );

  return (
    <nav className="sidebar">
      <NavLink to="/" end className="sidebar__link">
        <House size={21} />
        <span>Главная</span>
      </NavLink>
      <NavLink to="/library" className="sidebar__link">
        <Bookmark size={21} />
        <span>Полка</span>
      </NavLink>
      <NavLink to="/downloads" className="sidebar__link">
        <Download size={21} />
        <span>Загрузки</span>
        {activeDownloads > 0 && <em className="sidebar__badge">{activeDownloads}</em>}
      </NavLink>
      <div className="sidebar__gap" />
      <NavLink to="/settings" className="sidebar__link">
        <Settings size={21} />
        <span>Настройки</span>
      </NavLink>
    </nav>
  );
}
