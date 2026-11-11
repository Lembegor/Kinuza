// The mini player: the app's window shrunk to a small always-on-top frame in a corner of the
// screen, and put back exactly as it was afterwards.

import { isDesktop } from "./backend";

/** Size of the mini window in logical pixels: 16:9, readable but out of the way. */
const miniWidth = 480;
const miniHeight = 270;
/** Gap between the mini window and the edges of the screen. */
const screenMargin = 24;

interface SavedWindow {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
}

let saved: SavedWindow | null = null;

/** Turns the window into the mini player (`true`) or restores it (`false`). No effect outside the desktop app. */
export async function setMiniWindow(mini: boolean): Promise<void> {
  if (!isDesktop) return;
  const { getCurrentWindow, currentMonitor, LogicalSize, PhysicalSize, PhysicalPosition } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();

  if (mini) {
    if (saved) return;
    const [size, position, maximized, monitor] = await Promise.all([
      appWindow.outerSize(),
      appWindow.outerPosition(),
      appWindow.isMaximized(),
      currentMonitor(),
    ]);
    saved = { width: size.width, height: size.height, x: position.x, y: position.y, maximized };
    if (maximized) await appWindow.unmaximize();
    // The window's usual minimum is far larger than the mini player.
    await appWindow.setMinSize(new LogicalSize(miniWidth, miniHeight));
    await appWindow.setSize(new LogicalSize(miniWidth, miniHeight));
    if (monitor) {
      const scale = monitor.scaleFactor;
      const x = monitor.position.x + monitor.size.width - Math.round((miniWidth + screenMargin) * scale);
      // The taskbar usually sits at the bottom; twice the margin keeps clear of it.
      const y = monitor.position.y + monitor.size.height - Math.round((miniHeight + screenMargin * 3) * scale);
      await appWindow.setPosition(new PhysicalPosition(x, y));
    }
    await appWindow.setAlwaysOnTop(true);
    return;
  }

  if (!saved) return;
  const previous = saved;
  saved = null;
  await appWindow.setAlwaysOnTop(false);
  await appWindow.setMinSize(new LogicalSize(normalMinWidth, normalMinHeight));
  await appWindow.setSize(new PhysicalSize(previous.width, previous.height));
  await appWindow.setPosition(new PhysicalPosition(previous.x, previous.y));
  if (previous.maximized) await appWindow.maximize();
}

/** The window's minimum size in normal use; the same numbers as in `tauri.conf.json`. */
const normalMinWidth = 1040;
const normalMinHeight = 660;
