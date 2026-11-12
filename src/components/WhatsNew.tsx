import { useEffect, useRef } from "react";
import { create } from "zustand";
import { Sparkles } from "lucide-react";
import { changelog } from "../changelog";
import { getAppInfo, isDesktop } from "../lib/backend";
import { useT } from "../lib/i18n";
import { isTopDialog, useDialogFocus } from "../lib/useDialogFocus";

interface WhatsNewState {
  version: string | null;
  open: (version: string) => void;
  close: () => void;
}

export const useWhatsNew = create<WhatsNewState>((set) => ({
  version: null,
  open: (version) => set({ version: changelog[version] ? version : null }),
  close: () => set({ version: null }),
}));

export function hasChangelog(version: string): boolean {
  return Boolean(changelog[version]);
}

export function WhatsNew({ ready }: { ready: boolean }) {
  const { t, language } = useT();
  const version = useWhatsNew((state) => state.version);
  const close = useWhatsNew((state) => state.close);
  const dialogRef = useRef<HTMLDivElement>(null);
  const checked = useRef(false);
  useDialogFocus(dialogRef, version !== null);

  useEffect(() => {
    if (!ready || checked.current || !isDesktop) return;
    checked.current = true;
    void getAppInfo().then((info) => {
      if (info.updatedFrom !== null && info.updatedFrom !== info.version) useWhatsNew.getState().open(info.version);
    });
  }, [ready]);

  useEffect(() => {
    if (version === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !isTopDialog(dialogRef)) return;
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [version, close]);

  if (version === null) return null;
  const items = changelog[version]?.[language] ?? changelog[version]?.en ?? [];
  return (
    <div className="backdrop backdrop--top" onMouseDown={close}>
      <div
        ref={dialogRef}
        className="dialog dialog--small whats-new"
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="whats-new__badge">
          <Sparkles size={18} />
        </div>
        <h2 id="whats-new-title">{t("whatsNew.title", { version })}</h2>
        <ul className="whats-new__list">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="dialog__actions">
          <button className="button button--primary" data-autofocus onClick={close}>
            {t("whatsNew.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
