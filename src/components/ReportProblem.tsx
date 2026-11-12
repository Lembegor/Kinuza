import { useState } from "react";
import { CircleCheck, LoaderCircle, Save, Send } from "lucide-react";
import { backend, describeError, isDesktop } from "../lib/backend";
import { t as translate, useT } from "../lib/i18n";
import { useJournal } from "../lib/journal";
import { useSettings } from "../state/settings";
import { useUi } from "../state/ui";

const botToken: string = import.meta.env.VITE_REPORT_BOT_TOKEN ?? "";
const chatId: string = import.meta.env.VITE_REPORT_CHAT_ID ?? "";
const resendPauseMs = 60_000;
const descriptionLimit = 4000;
const privateSettings = ["tmdbKey", "downloadDir"];

function journalText(): string {
  return useJournal
    .getState()
    .entries.slice(0, 80)
    .map((entry) => `${new Date(entry.time).toISOString()} [${entry.area}] ${translate(entry.message)}${entry.detail ? ` — ${entry.detail}` : ""}${entry.count > 1 ? ` ×${entry.count}` : ""}`)
    .join("\n");
}

function settingsText(): string {
  const { loaded: _loaded, load: _load, patch: _patch, ...settings } = useSettings.getState();
  const safe = Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, privateSettings.includes(key) ? (value ? "(set)" : "") : value]));
  return JSON.stringify(safe, null, 1);
}

export function ReportProblem() {
  const { t } = useT();
  const toast = useUi((state) => state.toast);
  const [description, setDescription] = useState("");
  const [sender, setSender] = useState("");
  const [includeLog, setIncludeLog] = useState(true);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const configured = botToken !== "" && chatId !== "";
  const request = () => ({ description, sender, journal: journalText(), settings: settingsText(), includeLog });

  const send = async () => {
    if (!description.trim()) {
      toast(t("report.empty"), "error");
      return;
    }
    setState("sending");
    try {
      await backend.sendReport(botToken, chatId, request());
      setState("sent");
      setDescription("");
      setTimeout(() => setState("idle"), resendPauseMs);
    } catch (error) {
      setState("idle");
      toast(describeError(error), "error");
    }
  };

  const save = async () => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const path = await backend.pickSaveTarget({ title: t("report.save"), defaultName: `kinuza-report-${day}.txt`, filterName: "Text", extensions: ["txt"] });
      if (!path) return;
      await backend.writeTextFile(path, await backend.buildReport(request()));
      toast(t("report.saved"), "success");
    } catch (error) {
      toast(describeError(error), "error");
    }
  };

  return (
    <section className="settings-group report">
      <h2>{t("report.title")}</h2>
      <p className="report__lead">{t(configured ? "report.lead" : "report.leadOffline")}</p>
      <label className="report__field">
        <span>{t("report.description")}</span>
        <textarea
          className="input report__text"
          value={description}
          maxLength={descriptionLimit}
          rows={5}
          placeholder={t("report.placeholder")}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label className="report__field">
        <span>{t("report.sender")}</span>
        <input className="input" value={sender} maxLength={80} placeholder={t("report.sender.placeholder")} onChange={(event) => setSender(event.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={includeLog} onChange={(event) => setIncludeLog(event.target.checked)} />
        <span>{t("report.includeLog")}</span>
      </label>
      <p className="report__privacy">{t("report.privacy")}</p>
      <div className="report__actions">
        {configured && (
          <button className="button button--primary" disabled={!isDesktop || state !== "idle" || !description.trim()} onClick={() => void send()}>
            {state === "sending" ? <LoaderCircle size={16} className="spin" /> : state === "sent" ? <CircleCheck size={16} /> : <Send size={16} />}
            {state === "sent" ? t("report.sent") : t("report.send")}
          </button>
        )}
        <button className="button" disabled={!isDesktop} onClick={() => void save()}>
          <Save size={16} />
          {t("report.save")}
        </button>
      </div>
    </section>
  );
}
