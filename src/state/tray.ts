import { backend } from "../lib/backend";
import { t } from "../lib/i18n";
import { report } from "../lib/journal";
import { useSettings } from "./settings";

export function keepTrayInStep(): void {
  let applied = "";
  const apply = () => {
    const { loaded, closeToTray, language } = useSettings.getState();
    const wanted = `${closeToTray}|${language}`;
    if (!loaded || wanted === applied) return;
    applied = wanted;
    backend
      .configureTray(closeToTray, { open: t("tray.open"), quit: t("tray.quit"), tooltip: "Kinuza" })
      .catch((error) => report("system", "journal.tray.failed", error));
  };
  useSettings.subscribe(apply);
  apply();
}
