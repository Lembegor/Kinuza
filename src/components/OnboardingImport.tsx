import { useRef, useState, type ChangeEvent } from "react";
import { ChevronDown, ChevronUp, CircleAlert, CircleCheck, FileUp, LoaderCircle } from "lucide-react";
import { backend, describeError, isDesktop } from "../lib/backend";
import { useT } from "../lib/i18n";
import { useImport } from "../state/importer";
import { useUi } from "../state/ui";

const importExtensions = ["csv", "json"];

const services = [
  { id: "letterboxd", name: "Letterboxd", steps: "onboarding.import.letterboxd.steps" },
  { id: "trakt", name: "Trakt", steps: "onboarding.import.trakt.steps" },
] as const;

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function OnboardingImport() {
  const { t } = useT();
  const { phase, processed, total, summary, problem, start, cancel, dismiss } = useImport();
  const toast = useUi((state) => state.toast);
  const fileInput = useRef<HTMLInputElement>(null);
  const [help, setHelp] = useState<string | null>(null);
  const running = phase === "running";

  const pickFile = async () => {
    if (!isDesktop) {
      fileInput.current?.click();
      return;
    }
    try {
      const picked = await backend.pickFile({ title: t("import.dialog"), filterName: t("import.dialog.filter"), extensions: importExtensions });
      if (!picked) return;
      void start(new Uint8Array(await backend.readFileBytes(picked)), baseName(picked));
    } catch (error) {
      toast(describeError(error), "error");
    }
  };

  const onFileChosen = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void start(new Uint8Array(await file.arrayBuffer()), file.name);
  };

  return (
    <div className="onboarding-import">
      <div className="onboarding-import__head">
        <FileUp size={18} />
        <div>
          <strong>{t("onboarding.import.title")}</strong>
          <p>{t("onboarding.import.text")}</p>
        </div>
        {!running && (
          <button className="button button--primary" onClick={() => void pickFile()}>
            {t("onboarding.import.pick")}
          </button>
        )}
        {!isDesktop && <input ref={fileInput} type="file" hidden accept=".csv,.json" onChange={(event) => void onFileChosen(event)} />}
      </div>

      <div className="onboarding-import__services">
        {services.map((service) => (
          <div key={service.id} className="onboarding-import__service">
            <button className="text-button" aria-expanded={help === service.id} onClick={() => setHelp(help === service.id ? null : service.id)}>
              {help === service.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {t("onboarding.import.where", { service: service.name })}
            </button>
            {help === service.id && <p className="onboarding-import__steps">{t(service.steps)}</p>}
          </div>
        ))}
      </div>

      {running && (
        <div className="onboarding-import__status" aria-live="polite">
          <LoaderCircle size={16} className="spin" />
          <span>{t("import.progress", { done: processed, total })}</span>
          <button className="text-button" onClick={cancel}>
            {t("common.cancel")}
          </button>
        </div>
      )}
      {phase === "done" && summary && (
        <div className="onboarding-import__status is-done" aria-live="polite">
          <CircleCheck size={16} />
          <span>{t("onboarding.import.done", { added: summary.added + summary.updated, missing: summary.notFound.length })}</span>
          <button className="text-button" onClick={dismiss}>
            {t("common.close")}
          </button>
        </div>
      )}
      {phase === "failed" && (
        <div className="onboarding-import__status is-failed" aria-live="polite">
          <CircleAlert size={16} />
          <span>{problem === "unknownFormat" ? t("import.error.unknownFormat") : problem === "empty" ? t("import.error.empty") : t("import.error.malformed")}</span>
          <button className="text-button" onClick={dismiss}>
            {t("common.close")}
          </button>
        </div>
      )}
    </div>
  );
}
