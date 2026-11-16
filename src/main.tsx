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
import "./styles/profile.css";
import "./styles/home.css";
import "./styles/social.css";
import App from "./App";
import { retryFailedImages } from "./lib/imageRetry";
import { backend } from "./lib/backend";
import { mpv } from "./lib/mpv";
import { guardAppClose } from "./lib/lifecycle";
import { startWatchedCleanup } from "./state/cleanup";
import { flushLibrary } from "./state/library";
import { startDownloadNotifications, startEpisodeNotifications } from "./state/notifications";
import { useSettings } from "./state/settings";
import { keepTrayInStep } from "./state/tray";

const describeFailure = (reason: unknown) =>
  reason instanceof Error ? `${reason.message} ${reason.stack?.split("\n").slice(1, 4).join(" | ") ?? ""}` : String(reason);
window.addEventListener("error", (event) => {
  void backend.appLog(`ui error: ${describeFailure(event.error ?? event.message)} at ${event.filename}:${event.lineno}`);
});
window.addEventListener("unhandledrejection", (event) => {
  void backend.appLog(`ui error: unhandled ${describeFailure(event.reason)}`);
});
window.addEventListener("blur", () => void backend.appLog("ui: window lost focus"));
window.addEventListener("focus", () => void backend.appLog("ui: window got focus"));

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
