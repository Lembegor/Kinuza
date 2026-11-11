// Work that must finish before the window closes: the last playback position, unsaved documents.
// Also decides what "close" means: with "keep running in the tray" on, the window only hides.

import { isDesktop } from "./backend";
import { report } from "./journal";

type Task = () => void | Promise<void>;

const tasks = new Set<Task>();
/** The tray's "Quit" sends this to the window. */
const quitEvent = "tray-quit";

/** Registers something to run when the app is closing; returns the function that unregisters it. */
export function beforeAppClose(task: Task): () => void {
  tasks.add(task);
  return () => {
    tasks.delete(task);
  };
}

async function runTasks(finish: Task): Promise<void> {
  for (const task of [...tasks, finish]) {
    try {
      await task();
    } catch (error) {
      report("system", "journal.close.failed", error);
    }
  }
}

/**
 * Holds the window open until every registered task has run, then `finish` (the tasks may
 * leave something for it to write). The close button, Alt+F4 and the taskbar all end up here.
 * When `staysInTray()` says so, closing hides the window instead and nothing is shut down.
 */
export async function guardAppClose(finish: Task, staysInTray: () => boolean): Promise<void> {
  if (!isDesktop) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { listen } = await import("@tauri-apps/api/event");
  const appWindow = getCurrentWindow();

  // The window is destroyed by the API once this handler returns without preventing it.
  await appWindow.onCloseRequested(async (event) => {
    if (staysInTray()) {
      event.preventDefault();
      // What has been watched so far is saved all the same: the app may be quit from the tray later.
      await runTasks(finish);
      await appWindow.hide();
      return;
    }
    await runTasks(finish);
  });

  await listen(quitEvent, async () => {
    await runTasks(finish);
    await appWindow.destroy();
  });
}
