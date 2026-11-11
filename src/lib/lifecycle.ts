import { isDesktop } from "./backend";
import { report } from "./journal";

type Task = () => void | Promise<void>;

const tasks = new Set<Task>();
const quitEvent = "tray-quit";

export function beforeAppClose(task: Task): () => void {
  tasks.add(task);
  return () => {
    tasks.delete(task);
  };
}

export async function runBeforeClose(): Promise<void> {
  await runTasks(() => undefined);
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

export async function guardAppClose(finish: Task, staysInTray: () => boolean): Promise<void> {
  if (!isDesktop) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { listen } = await import("@tauri-apps/api/event");
  const appWindow = getCurrentWindow();

  await appWindow.onCloseRequested(async (event) => {
    if (staysInTray()) {
      event.preventDefault();
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
