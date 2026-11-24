import { useEffect, useState } from "react";
import { LoaderCircle, LogIn, ShieldAlert } from "lucide-react";
import { useT } from "../lib/i18n";
import { rutracker, rutrackerErrors } from "../lib/rutracker";
import { useServerNotice } from "../state/serverNotice";
import { useUi } from "../state/ui";

export function ServerNotice() {
  const { t } = useT();
  const open = useServerNotice((state) => state.open);
  const watching = useUi((state) => state.player !== null);
  const searching = useUi((state) => state.addSource !== null);
  const [busy, setBusy] = useState(false);
  const visible = open && !watching && !searching;

  useEffect(() => {
    if (!visible) return;
    useServerNotice.getState().markShown();
    void useServerNotice.getState().recheckRoute();
  }, [visible]);

  if (!visible) return null;

  const signIn = async () => {
    setBusy(true);
    try {
      await rutracker.login();
      useUi.getState().toast(t("settings.accounts.rutracker.signedInToast"), "success");
      useServerNotice.getState().close();
    } catch (failure) {
      if (failure !== rutrackerErrors.cancelled) useUi.getState().toast(t("tracker.error.loginFailed"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="server-notice" role="status">
      <span className="server-notice__icon">
        <ShieldAlert size={20} />
      </span>
      <div className="server-notice__body">
        <b>{t("serverNotice.title")}</b>
        <p>{t("serverNotice.text")}</p>
        <div className="server-notice__actions">
          <button type="button" className="button button--primary button--small" disabled={busy} onClick={() => void signIn()}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <LogIn size={14} />}
            {t("tracker.server.login")}
          </button>
          <button type="button" className="button button--small" disabled={busy} onClick={() => useServerNotice.getState().close()}>
            {t("common.close")}
          </button>
          <button type="button" className="server-notice__never" disabled={busy} onClick={() => useServerNotice.getState().never()}>
            {t("serverNotice.never")}
          </button>
        </div>
      </div>
    </div>
  );
}
