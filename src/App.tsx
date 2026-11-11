import { useEffect, useRef, useState } from "react";
import { HashRouter, Route, Routes, useLocation } from "react-router-dom";
import { FileDown } from "lucide-react";
import { AddSourceDialog } from "./components/AddSourceDialog";
import { Onboarding } from "./components/Onboarding";
import { ConfirmDialog, Toasts, UpdateNotice } from "./components/Overlays";
import { Player } from "./components/Player";
import { Sidebar, Titlebar } from "./components/Shell";
import { backend, describeError, isDesktop, onLaunchRequest, type LaunchRequest } from "./lib/backend";
import { t, useT } from "./lib/i18n";
import { report } from "./lib/journal";
import { isMagnetLink } from "./lib/parse";
import Browse from "./pages/Browse";
import Diagnostics from "./pages/Diagnostics";
import CalendarPage from "./pages/Calendar";
import Downloads from "./pages/Downloads";
import Home from "./pages/Home";
import Library from "./pages/Library";
import PersonPage from "./pages/Person";
import Search from "./pages/Search";
import Settings from "./pages/Settings";
import TitlePage from "./pages/Title";
import { useLibrary } from "./state/library";
import { useSettings } from "./state/settings";
import { startTorrentPolling } from "./state/torrents";
import { useUi } from "./state/ui";
import { notify } from "./state/notifications";
import { useUpdater } from "./state/updater";

const updateCheckDelayMs = 4000;
/** The app lives in the tray for days; a new version is looked for again this often. */
const updateCheckIntervalMs = 4 * 60 * 60 * 1000;

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
        else toast(t("shell.drop.notTorrent"), "error");
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

/** Opens the add dialog for a link clicked in the browser or a .torrent opened from Explorer. */
function openLaunchRequest(request: LaunchRequest): void {
  const { pageTarget, openAddSource } = useUi.getState();
  const source = request.kind === "magnet" ? { magnet: request.value } : { filePath: request.value };
  openAddSource({ target: null, suggested: pageTarget, ...source });
}

function useLaunchRequests(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void backend.takeLaunchRequest().then((request) => {
      if (request && !disposed) openLaunchRequest(request);
    });
    void onLaunchRequest(openLaunchRequest).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [ready]);
}

async function enableLinkHandling(): Promise<void> {
  try {
    await backend.setAssociations(true);
    useSettings.getState().patch({ handleLinks: true });
  } catch (error) {
    useUi.getState().toast(describeError(error), "error");
  }
}

/** Keeps the Windows registration pointing at this executable; asks once whether to register at all. */
function useLinkHandling(ready: boolean): void {
  useEffect(() => {
    if (!ready || !isDesktop) return;
    const { handleLinks, linksPrompted, patch } = useSettings.getState();
    if (handleLinks) {
      void backend.setAssociations(true).catch((error) => report("system", "journal.associations.failed", error));
      return;
    }
    if (linksPrompted) return;
    patch({ linksPrompted: true });
    useUi.getState().askConfirm({
      title: t("shell.links.title"),
      message: t("shell.links.message"),
      confirmLabel: t("shell.links.confirm"),
      onConfirm: () => void enableLinkHandling(),
    });
  }, [ready]);
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
        <Route path="/browse" element={<Browse />} />
        <Route path="/search" element={<Search />} />
        <Route path="/title/:type/:id" element={<TitlePage />} />
        <Route path="/person/:id" element={<PersonPage />} />
        <Route path="/library" element={<Library />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/downloads" element={<Downloads />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/diagnostics" element={<Diagnostics />} />
      </Routes>
    </main>
  );
}

export default function App() {
  const settingsLoaded = useSettings((state) => state.loaded);
  const autoUpdate = useSettings((state) => state.autoUpdate);
  const libraryLoaded = useLibrary((state) => state.loaded);
  const language = useSettings((state) => state.language);
  // The first start: the language is not chosen yet, or the user has nothing here and has not been shown around.
  const introducing = useLibrary((state) => state.firstRun) || !language;
  const { t } = useT();

  useEffect(() => {
    void useSettings.getState().load();
    void useLibrary.getState().load();
    return startTorrentPolling();
  }, []);


  useEffect(() => {
    if (!settingsLoaded || !autoUpdate) return;
    const timer = setTimeout(() => void useUpdater.getState().check(), updateCheckDelayMs);
    const repeat = setInterval(() => {
      // A version already found (offered, postponed or being installed) is not asked about again.
      const { status } = useUpdater.getState();
      if (status !== "idle" && status !== "upToDate" && status !== "error") return;
      void useUpdater
        .getState()
        .check()
        .then(() => {
          // Found while the app has been open for hours, likely in the tray: the card inside the
          // window would go unseen, so the system says it too.
          const found = useUpdater.getState();
          if (found.status === "available") return notify(t("notifications.update"), `Kinuza ${found.version}`);
        })
        .catch((error) => report("updates", "journal.notifications.failed", error));
    }, updateCheckIntervalMs);
    return () => {
      clearTimeout(timer);
      clearInterval(repeat);
    };
  }, [settingsLoaded, autoUpdate]);

  useMagnetPaste();
  const dragging = useTorrentDrop();
  const ready = settingsLoaded && libraryLoaded;
  useLaunchRequests(ready);
  // The question about links is worded in the interface language, so it waits until one is chosen.
  // It also waits for the introduction to end: one thing at a time.
  useLinkHandling(ready && !introducing);

  // The webview's own context menu (reload, inspect) has no place in the app.
  useEffect(() => {
    if (!isDesktop || import.meta.env.DEV) return;
    const block = (event: MouseEvent) => {
      if (!isTextField(event.target)) event.preventDefault();
    };
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);

  if (!ready) return <div className="app app--loading" />;
  // First start: nothing else is shown until the app knows which language to speak and the introduction is over.
  if (introducing) {
    return (
      <div className="app">
        <Onboarding />
      </div>
    );
  }

  return (
    <HashRouter key={language}>
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
            <strong>{t("shell.drop.release")}</strong>
          </div>
        )}
      </div>
    </HashRouter>
  );
}
