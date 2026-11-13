import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { isDesktop } from "../lib/backend";
import { useT } from "../lib/i18n";
import { rutracker, rutrackerErrors } from "../lib/rutracker";
import { useAsync } from "../lib/useAsync";
import { useUi } from "../state/ui";

export function TrackerAccount() {
  const { t } = useT();
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const account = useAsync(() => (isDesktop ? rutracker.account() : Promise.resolve(null)), [version]);
  const signedIn = account.data?.signedIn ?? false;
  const server = useAsync(
    () => (isDesktop && account.data && !account.data.signedIn ? rutracker.serverStatus() : Promise.resolve(null)),
    [version, account.data?.signedIn],
  );
  const refresh = () => setVersion((value) => value + 1);

  const shownBefore = useRef(false);

  useEffect(() => {
    if (shownBefore.current) setVersion((value) => value + 1);
    shownBefore.current = true;
    const onFocus = () => setVersion((value) => value + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const signIn = async () => {
    setBusy(true);
    try {
      await rutracker.login();
      useUi.getState().toast(t("settings.accounts.rutracker.signedInToast"), "success");
    } catch (failure) {
      if (failure !== rutrackerErrors.cancelled) useUi.getState().toast(t("tracker.error.loginFailed"), "error");
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const signOut = () =>
    useUi.getState().askConfirm({
      title: t("settings.accounts.rutracker.signOutTitle"),
      message: t("settings.accounts.rutracker.signOutMessage"),
      confirmLabel: t("settings.accounts.signOut"),
      danger: true,
      onConfirm: () => {
        setBusy(true);
        void rutracker
          .signOut()
          .then(() => useUi.getState().toast(t("settings.accounts.rutracker.signedOutToast"), "success"))
          .catch(() => useUi.getState().toast(t("settings.accounts.rutracker.signOutFailed"), "error"))
          .finally(() => {
            setBusy(false);
            refresh();
          });
      },
    });

  const status = account.loading && !account.data
    ? t("settings.accounts.checking")
    : account.error || !account.data
      ? t("settings.accounts.unknown")
      : signedIn
        ? t("settings.accounts.rutracker.signedIn")
        : server.data && server.data.state !== "ready"
          ? t("settings.accounts.rutracker.signedOutServerDown")
          : t("settings.accounts.rutracker.signedOut");

  return (
    <div className="setting">
      <div>
        <strong>RuTracker</strong>
        <p>{status}</p>
      </div>
      <div className="setting__actions">
        {busy && <LoaderCircle size={16} className="spin" />}
        {signedIn ? (
          <button className="button" disabled={busy || !isDesktop} onClick={signOut}>
            {t("settings.accounts.signOut")}
          </button>
        ) : (
          <button className="button" disabled={busy || !isDesktop} onClick={() => void signIn()}>
            {t("settings.accounts.signIn")}
          </button>
        )}
      </div>
    </div>
  );
}
