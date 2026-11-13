import { useEffect, useRef } from "react";
import { create } from "zustand";
import { Sparkles } from "lucide-react";
import { changelog, type ChangelogLine } from "../changelog";
import { getAppInfo, isDesktop } from "../lib/backend";
import { useT } from "../lib/i18n";
import { isTopDialog, useDialogFocus } from "../lib/useDialogFocus";

type Mode = "update" | "history";

interface WhatsNewState {
  versions: string[];
  mode: Mode;
  open: (versions: string[], mode: Mode) => void;
  close: () => void;
}

function parts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function knownVersions(): string[] {
  return Object.keys(changelog).sort((a, b) => compareVersions(b, a));
}

export function versionsSince(previous: string, current: string): string[] {
  return knownVersions().filter((version) => compareVersions(version, current) <= 0 && (previous === "" || compareVersions(version, previous) > 0));
}

interface Group {
  heading: string | null;
  items: string[];
}

function groupsOf(lines: ChangelogLine[]): Group[] {
  const groups: Group[] = [];
  for (const line of lines) {
    if (typeof line === "string") {
      if (groups.length === 0) groups.push({ heading: null, items: [] });
      groups[groups.length - 1].items.push(line);
    } else {
      groups.push({ heading: line.heading, items: [] });
    }
  }
  return groups;
}

export function ChangelogGroups({ lines }: { lines: ChangelogLine[] }) {
  return (
    <>
      {groupsOf(lines).map((group, index) => (
        <div key={`${group.heading ?? ""}${index}`} className="whats-new__group">
          {group.heading && <p className="whats-new__heading">{group.heading}</p>}
          <ol className="whats-new__list">
            {group.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ol>
        </div>
      ))}
    </>
  );
}

let announcedThisRun = false;

export const useWhatsNew = create<WhatsNewState>((set) => ({
  versions: [],
  mode: "update",
  open: (versions, mode) => set({ versions: versions.filter((version) => changelog[version]), mode }),
  close: () => set({ versions: [] }),
}));

export function openHistory(current: string): void {
  useWhatsNew.getState().open(
    knownVersions().filter((version) => compareVersions(version, current) <= 0),
    "history",
  );
}

export function hasHistory(current: string): boolean {
  return knownVersions().some((version) => compareVersions(version, current) <= 0);
}

export function WhatsNew({ ready }: { ready: boolean }) {
  const { t, language } = useT();
  const versions = useWhatsNew((state) => state.versions);
  const mode = useWhatsNew((state) => state.mode);
  const close = useWhatsNew((state) => state.close);
  const dialogRef = useRef<HTMLDivElement>(null);
  const shown = versions.length > 0;
  useDialogFocus(dialogRef, shown);

  useEffect(() => {
    if (!ready || announcedThisRun || !isDesktop) return;
    announcedThisRun = true;
    void getAppInfo().then((info) => {
      if (info.updatedFrom === null || info.updatedFrom === info.version) return;
      const missed = versionsSince(info.updatedFrom, info.version);
      if (missed.length > 0) useWhatsNew.getState().open(missed, "update");
    });
  }, [ready]);

  useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !isTopDialog(dialogRef)) return;
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown, close]);

  if (!shown) return null;
  const single = versions.length === 1 && mode === "update";
  const title = mode === "history" ? t("whatsNew.history") : single ? t("whatsNew.title", { version: versions[0] }) : t("whatsNew.titleMany");
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
        <h2 id="whats-new-title">{title}</h2>
        <div className="whats-new__versions">
          {versions.map((version) => {
            const lines = changelog[version]?.[language] ?? changelog[version]?.en ?? [];
            return (
              <section key={version} className="whats-new__version">
                {!single && <h3>{t("whatsNew.version", { version })}</h3>}
                <ChangelogGroups lines={lines} />
              </section>
            );
          })}
        </div>
        <div className="dialog__actions">
          <button className="button button--primary" data-autofocus onClick={close}>
            {t("whatsNew.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}
