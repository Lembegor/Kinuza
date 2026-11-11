import { isDesktop } from "./backend";

const miniWidth = 480;
const miniHeight = 270;
const screenMargin = 24;

interface SavedWindow {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
}

let saved: SavedWindow | null = null;

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
    await appWindow.setMinSize(new LogicalSize(miniWidth, miniHeight));
    await appWindow.setSize(new LogicalSize(miniWidth, miniHeight));
    if (monitor) {
      const scale = monitor.scaleFactor;
      const x = monitor.position.x + monitor.size.width - Math.round((miniWidth + screenMargin) * scale);
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

const normalMinWidth = 1040;
const normalMinHeight = 660;
