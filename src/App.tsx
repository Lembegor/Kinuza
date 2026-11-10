import { useEffect, useRef, useState } from "react";
import { HashRouter, Route, Routes, useLocation } from "react-router-dom";
import { FileDown } from "lucide-react";
import { AddSourceDialog } from "./components/AddSourceDialog";
import { ConfirmDialog, Toasts, UpdateNotice } from "./components/Overlays";
import { Player } from "./components/Player";
import { Sidebar, Titlebar } from "./components/Shell";
import { isDesktop } from "./lib/backend";
import { isMagnetLink } from "./lib/parse";
import Downloads from "./pages/Downloads";
import Home from "./pages/Home";
import Library from "./pages/Library";
import Search from "./pages/Search";
import Settings from "./pages/Settings";
import TitlePage from "./pages/Title";
import { useLibrary } from "./state/library";
import { useSettings } from "./state/settings";
import { startTorrentPolling } from "./state/torrents";
import { useUi } from "./state/ui";
import { useUpdater } from "./state/updater";

const updateCheckDelayMs = 4000;

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/** A magnet link pasted anywhere outside a text field opens the add dialog for the title on screen. */
function useMagnetPaste(): void {
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isTextField(event.target)) return;
      const text = event.clipboardData?.getData("text") ?? "";
      if (!isMagnetLink(text)) return;
      event.preventDefault();
      const { pageTarget, openAddSource } = useUi.getState();
      openAddSource({ target: pageTarget, magnet: text.trim() });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);
}

/** Dropping a .torrent file on the window opens the add dialog. Returns whether a drag is in progress. */
function useTorrentDrop(): boolean {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragging(true);
          return;
        }
        setDragging(false);
        if (payload.type !== "drop") return;
        const torrentFile = payload.paths.find((path) => path.toLowerCase().endsWith(".torrent"));
        const { pageTarget, openAddSource, toast } = useUi.getState();
        if (torrentFile) openAddSource({ target: pageTarget, filePath: torrentFile });
        else toast("Перетащите файл с расширением .torrent.", "error");
      });
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return dragging;
}

function Content() {
  const location = useLocation();
  const scrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <main className="content" ref={scrollRef}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/search" element={<Search />} />
        <Route path="/title/:type/:id" element={<TitlePage />} />
        <Route path="/library" element={<Library />} />
        <Route path="/downloads" element={<Downloads />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </main>
  );
}

export default function App() {
  const settingsLoaded = useSettings((state) => state.loaded);
  const autoUpdate = useSettings((state) => state.autoUpdate);
  const libraryLoaded = useLibrary((state) => state.loaded);

  useEffect(() => {
    void useSettings.getState().load();
    void useLibrary.getState().load();
    return startTorrentPolling();
  }, []);

  useEffect(() => {
    if (!settingsLoaded || !autoUpdate) return;
    const timer = setTimeout(() => void useUpdater.getState().check(), updateCheckDelayMs);
    return () => clearTimeout(timer);
  }, [settingsLoaded, autoUpdate]);

  useMagnetPaste();
  const dragging = useTorrentDrop();

  // The webview's own context menu (reload, inspect) has no place in the app.
  useEffect(() => {
    if (!isDesktop || import.meta.env.DEV) return;
    const block = (event: MouseEvent) => {
      if (!isTextField(event.target)) event.preventDefault();
    };
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);

  if (!settingsLoaded || !libraryLoaded) return <div className="app app--loading" />;

  return (
    <HashRouter>
      <div className="app">
        <Titlebar />
        <Sidebar />
        <Content />
        <Player />
        <AddSourceDialog />
        <ConfirmDialog />
        <UpdateNotice />
        <Toasts />
        {dragging && (
          <div className="drop-overlay">
            <FileDown size={44} />
            <strong>Отпустите .torrent-файл</strong>
          </div>
        )}
      </div>
    </HashRouter>
  );
}
