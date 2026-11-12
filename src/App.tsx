import { useEffect, useState } from "react";
import { HashRouter, Route } from "react-router-dom";
import { FileDown } from "lucide-react";
import { AddSourceDialog } from "./components/AddSourceDialog";
import { Onboarding } from "./components/Onboarding";
import { AppHotkeys, ConfirmDialog, Toasts, UpdateNotice } from "./components/Overlays";
import { PageStack } from "./components/PageStack";
import { WhatsNew } from "./components/WhatsNew";
import { Player } from "./components/Player";
import { Sidebar, Titlebar } from "./components/Shell";
import { backend, describeError, getAppInfo, isDesktop, onLaunchRequest, type LaunchRequest } from "./lib/backend";
import { t, useT } from "./lib/i18n";
import { report } from "./lib/journal";
import { applyAppearance } from "./lib/appearance";
import { mpv } from "./lib/mpv";
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
import Storage from "./pages/Storage";
import TitlePage from "./pages/Title";
import { useInbox } from "./state/inbox";
import { useLibrary } from "./state/library";
import { useSettings } from "./state/settings";
import { startTorrentPolling } from "./state/torrents";
import { scheduleSourceRepair } from "./state/sourceRepair";
import { useUi } from "./state/ui";
import { notify } from "./state/notifications";
import { useUpdater } from "./state/updater";

const updateCheckDelayMs = 4000;
const mpvWarmDelayMs = 2500;
const updateCheckIntervalMs = 4 * 60 * 60 * 1000;

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

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

const pageRoutes = (
  <>
    <Route path="/" element={<Home />} />
    <Route path="/browse" element={<Browse />} />
    <Route path="/search" element={<Search />} />
    <Route path="/title/:type/:id" element={<TitlePage />} />
    <Route path="/person/:id" element={<PersonPage />} />
    <Route path="/library" element={<Library />} />
    <Route path="/calendar" element={<CalendarPage />} />
    <Route path="/downloads" element={<Downloads />} />
    <Route path="/settings" element={<Settings />} />
    <Route path="/storage" element={<Storage />} />
    <Route path="/diagnostics" element={<Diagnostics />} />
  </>
);

function Content() {
  return (
    <main className="content">
      <PageStack routes={pageRoutes} />
    </main>
  );
}

export default function App() {
  const settingsLoaded = useSettings((state) => state.loaded);
  const autoUpdate = useSettings((state) => state.autoUpdate);
  const libraryLoaded = useLibrary((state) => state.loaded);
  const language = useSettings((state) => state.language);
  const accent = useSettings((state) => state.accent);
  const density = useSettings((state) => state.gridDensity);
  const introducing = useLibrary((state) => state.firstRun) || !language;
  const { t } = useT();

  useEffect(() => applyAppearance(accent, density), [accent, density]);

  useEffect(() => {
    void useSettings.getState().load();
    void useLibrary.getState().load();
    void useInbox.getState().load();
    void getAppInfo().then((info) => {
      if (info.sessionReset) useUi.getState().toast(t("shell.sessionReset"), "info");
    });
    const warm = setTimeout(() => {
      if (mpv.supported) void mpv.warm().catch(() => undefined);
    }, mpvWarmDelayMs);
    const stopPolling = startTorrentPolling();
    const stopRepair = scheduleSourceRepair();
    return () => {
      clearTimeout(warm);
      stopPolling();
      stopRepair();
    };
  }, []);

  useEffect(() => {
    if (!settingsLoaded || !autoUpdate) return;
    const timer = setTimeout(() => void useUpdater.getState().check(), updateCheckDelayMs);
    const repeat = setInterval(() => {
      const { status } = useUpdater.getState();
      if (status !== "idle" && status !== "upToDate" && status !== "error") return;
      void useUpdater
        .getState()
        .check()
        .then(() => {
          const found = useUpdater.getState();
          if (found.status === "available") {
            useInbox.getState().add({ kind: "update", title: t("notifications.update"), body: `Kinuza ${found.version}`, link: "/settings" });
            return notify(t("notifications.update"), `Kinuza ${found.version}`);
          }
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
  useLinkHandling(ready && !introducing);

  useEffect(() => {
    if (!isDesktop || import.meta.env.DEV) return;
    const block = (event: MouseEvent) => {
      if (!isTextField(event.target)) event.preventDefault();
    };
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);

  if (!ready) return <div className="app app--loading" />;
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
        <AppHotkeys />
        <WhatsNew ready={!introducing} />
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
