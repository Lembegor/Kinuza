// The rows of the settings page that import ratings and lists from other services: the button,
// then the progress of a running import or the summary of a finished one.

import { useRef, useState, type ChangeEvent } from "react";
import { ChevronDown, ChevronUp, CircleAlert, CircleCheck } from "lucide-react";
import { backend, describeError, isDesktop } from "../lib/backend";
import type { ImportProblem, ImportSource } from "../lib/importers";
import { useT, type MessageKey } from "../lib/i18n";
import { useImport, type ImportSummary } from "../state/importer";
import { useUi } from "../state/ui";

const importExtensions = ["csv", "json", "tsv", "txt"];

const sourceNames: Record<ImportSource, MessageKey> = {
  imdb: "import.source.imdb",
  letterboxd: "import.source.letterboxd",
  trakt: "import.source.trakt",
  kinopoisk: "import.source.kinopoisk",
};

const problemTexts: Record<ImportProblem, MessageKey> = {
  empty: "import.error.empty",
  unknownFormat: "import.error.unknownFormat",
  malformed: "import.error.malformed",
};

/** The file's name without the folders leading to it. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function Summary({ summary }: { summary: ImportSummary }) {
  const { t } = useT();
  const [missingShown, setMissingShown] = useState(false);
  const missing = summary.notFound.length;
  // Counts that are always told, and those worth a line only when there is something to tell.
  const counts: { label: MessageKey; value: number; always: boolean }[] = [
    { label: "import.summary.added", value: summary.added, always: true },
    { label: "import.summary.updated", value: summary.updated, always: false },
    { label: "import.summary.unchanged", value: summary.unchanged, always: true },
    { label: "import.summary.notFound", value: missing, always: true },
    { label: "import.summary.skipped", value: summary.skipped, always: false },
    { label: "import.summary.unchecked", value: summary.unchecked, always: false },
  ];

  return (
    <>
      <div className="import-counts">
        {counts
          .filter((count) => count.always || count.value > 0)
          .map((count) => (
            <div key={count.label}>
              <b>{count.value}</b>
              <span>{t(count.label)}</span>
            </div>
          ))}
      </div>
      {summary.unchecked > 0 && <p className="import-note import-note--warning">{t("import.note.unchecked")}</p>}
      {summary.unchanged > 0 && <p className="import-note">{t("import.note.unchanged")}</p>}
      {summary.skipped > 0 && <p className="import-note">{t("import.note.skipped")}</p>}
      {missing > 0 && (
        <>
          <button className="text-button" aria-expanded={missingShown} onClick={() => setMissingShown(!missingShown)}>
            {missingShown ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            {t(missingShown ? "import.notFound.hide" : "import.notFound.show")}
          </button>
          {missingShown && (
            <ul className="import-missing">
              {summary.notFound.map((name, index) => (
                <li key={index}>{name}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

export function ImportSetting() {
  const { t } = useT();
  const { phase, fileName, source, processed, total, summary, problem, start, cancel, dismiss } = useImport();
  const toast = useUi((state) => state.toast);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = phase === "running";
  // Finished, but not through the whole file: the catalog stopped answering on the way.
  const stopped = phase === "done" && summary !== null && summary.unchecked > 0;
  const heading: MessageKey = running ? "import.running" : stopped ? "import.stopped" : phase === "done" ? "import.done" : "import.failed";

  const pickFile = async () => {
    // A browser has no native dialogs; the hidden file input below stands in for one.
    if (!isDesktop) {
      fileInput.current?.click();
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ title: t("import.dialog"), filters: [{ name: t("import.dialog.filter"), extensions: importExtensions }] });
      if (typeof picked !== "string") return;
      void start(new Uint8Array(await backend.readFileBytes(picked)), baseName(picked));
    } catch (error) {
      toast(describeError(error), "error");
    }
  };

  const onFileChosen = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared so that choosing the same file again is still a change.
    event.target.value = "";
    if (file) void start(new Uint8Array(await file.arrayBuffer()), file.name);
  };

  const origin = source ? t("import.file", { source: t(sourceNames[source]), file: fileName }) : fileName;

  return (
    <>
      <div className="setting">
        <div>
          <strong>{t("settings.import")}</strong>
          <p>{t("settings.import.note")}</p>
        </div>
        <div className="setting__actions">
          <button className="button" disabled={running} onClick={() => void pickFile()}>
            {t("settings.import.pick")}
          </button>
          {!isDesktop && (
            <input ref={fileInput} type="file" hidden accept={importExtensions.map((extension) => `.${extension}`).join(",")} onChange={(event) => void onFileChosen(event)} />
          )}
        </div>
      </div>

      {phase !== "idle" && (
        <div className="setting setting--stack import" aria-live="polite">
          <div className="import__head">
            {phase === "done" && !stopped && <CircleCheck size={18} className="import__icon import__icon--done" />}
            {(phase === "failed" || stopped) && <CircleAlert size={18} className="import__icon import__icon--failed" />}
            <div className="import__title">
              <strong>{t(heading)}</strong>
              <p>{origin}</p>
            </div>
            <button className="button" onClick={running ? cancel : dismiss}>
              {running ? t("common.cancel") : t("common.close")}
            </button>
          </div>

          {running && (
            <>
              <div className="bar">
                <i style={{ width: `${total > 0 ? (processed / total) * 100 : 0}%` }} />
              </div>
              <p className="import-note">{t("import.progress", { done: processed, total })}</p>
            </>
          )}
          {phase === "done" && summary && <Summary summary={summary} />}
          {phase === "failed" && problem && <p className="import-note import-note--warning">{t(problemTexts[problem])}</p>}
        </div>
      )}
    </>
  );
}
