import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/manrope";
import "@fontsource-variable/unbounded";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/pages.css";
import "./styles/tools.css";
import "./styles/dialog.css";
import "./styles/player.css";
import App from "./App";
import { retryFailedImages } from "./lib/imageRetry";
import { mpv } from "./lib/mpv";
import { guardAppClose } from "./lib/lifecycle";
import { startWatchedCleanup } from "./state/cleanup";
import { flushLibrary } from "./state/library";
import { startDownloadNotifications, startEpisodeNotifications } from "./state/notifications";
import { useSettings } from "./state/settings";
import { keepTrayInStep } from "./state/tray";

retryFailedImages();
if (mpv.supported) void mpv.quit().catch(() => undefined);
if (!import.meta.env.DEV) {
  window.addEventListener(
    "keydown",
    (event) => {
      const reload = event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");
      if (reload) event.preventDefault();
    },
    true,
  );
}
startWatchedCleanup();
startDownloadNotifications();
startEpisodeNotifications();
keepTrayInStep();
void guardAppClose(flushLibrary, () => useSettings.getState().closeToTray);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
