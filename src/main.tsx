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
import { guardAppClose } from "./lib/lifecycle";
import { startWatchedCleanup } from "./state/cleanup";
import { flushLibrary } from "./state/library";
import { startDownloadNotifications, startEpisodeNotifications } from "./state/notifications";
import { useSettings } from "./state/settings";
import { keepTrayInStep } from "./state/tray";

retryFailedImages();
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
