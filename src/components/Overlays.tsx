import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Info, RefreshCw, X } from "lucide-react";
import { useT } from "../lib/i18n";
import { isTopDialog, useDialogFocus } from "../lib/useDialogFocus";
import { useUi, type Toast } from "../state/ui";
import { useUpdater } from "../state/updater";
import { HotkeyList } from "./HotkeyList";

const toastIcons = { info: Info, success: CircleCheck, error: CircleAlert };
const toastLifetimeMs = 5000;
const errorToastLifetimeMs = 9000;
const actionToastLifetimeMs = 10000;

function toastLifetime(toast: Toast): number {
  if (toast.action) return actionToastLifetimeMs;
  return toast.kind === "error" ? errorToastLifetimeMs : toastLifetimeMs;
}

function ToastItem({ toast }: { toast: Toast }) {
  const { t } = useT();
  const dismiss = useUi((state) => state.dismissToast);
  const [held, setHeld] = useState(false);
  const left = useRef(toastLifetime(toast));

  useEffect(() => {
    if (held) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => dismiss(toast.id), left.current);
    return () => {
      clearTimeout(timer);
      left.current = Math.max(1000, left.current - (Date.now() - startedAt));
    };
  }, [held, toast.id, dismiss]);

  const Icon = toastIcons[toast.kind];
  return (
    <div
      className={`toast toast--${toast.kind}`}
      role={toast.kind === "error" ? "alert" : "status"}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <Icon size={18} />
      <span>{toast.text}</span>
      {toast.action && (
        <button
          className="toast__action"
          onClick={() => {
            toast.action?.run();
            dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button className="toast__close" aria-label={t("common.close")} onClick={() => dismiss(toast.id)}>
        <X size={14} />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useUi((state) => state.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const request = useUi((state) => state.confirm);
  const close = useUi((state) => state.closeConfirm);
  const { t } = useT();
  const [optionChecked, setOptionChecked] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, request !== null);

  useEffect(() => setOptionChecked(false), [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !isTopDialog(dialogRef)) return;
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request, close]);

  if (!request) return null;
  return (
    <div className="backdrop backdrop--top" onMouseDown={close}>
      <div
        ref={dialogRef}
        className="dialog dialog--small"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-title">{request.title}</h2>
        <p className="dialog__text" id="confirm-message">
          {request.message}
        </p>
        {request.optionLabel && (
          <label className="check">
            <input type="checkbox" checked={optionChecked} onChange={(event) => setOptionChecked(event.target.checked)} />
            <span>{request.optionLabel}</span>
          </label>
        )}
        <div className="dialog__actions">
          <button className="button" data-autofocus onClick={close}>
            {t("common.cancel")}
          </button>
          {request.secondaryLabel && request.onSecondary && (
            <button
              className="button button--primary"
              onClick={() => {
                request.onSecondary?.();
                close();
              }}
            >
              {request.secondaryLabel}
            </button>
          )}
          <button
            className={`button ${request.danger ? "button--danger" : "button--primary"}`}
            onClick={() => {
              request.onConfirm(optionChecked);
              close();
            }}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function UpdateNotice() {
  const { status, version, notes, progress, dismissed, install, dismiss } = useUpdater();
  const { t } = useT();
  const visible = (status === "available" && !dismissed) || status === "downloading" || status === "installing";
  if (!visible) return null;

  return (
    <div className="update-notice">
      <div className="update-notice__head">
        <RefreshCw size={18} className={status === "available" ? "" : "spin"} />
        <strong>Kinuza {version}</strong>
        {status === "available" && (
          <button className="icon-button" aria-label={t("shell.update.later")} onClick={dismiss}>
            <X size={15} />
          </button>
        )}
      </div>
      {status === "available" && (
        <>
          <p>{notes.trim() || t("shell.update.available")}</p>
          <button className="button button--primary button--block" onClick={() => void install()}>
            {t("shell.update.install")}
          </button>
        </>
      )}
      {status !== "available" && (
        <>
          <p>{status === "installing" ? t("shell.update.installing") : t("shell.update.downloading", { percent: Math.round(progress * 100) })}</p>
          <div className="bar">
            <i style={{ width: `${progress * 100}%` }} />
          </div>
        </>
      )}
    </div>
  );
}

export function AppHotkeys() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      if (open && event.key === "Escape" && isTopDialog(dialogRef)) {
        event.stopImmediatePropagation();
        setOpen(false);
        return;
      }
      const ui = useUi.getState();
      if (typing || ui.player || ui.addSource || ui.confirm) return;
      if (event.shiftKey && event.code === "Slash" && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;
  return (
    <div className="backdrop backdrop--top" onMouseDown={() => setOpen(false)}>
      <div
        ref={dialogRef}
        className="dialog dialog--hotkeys"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hotkeys-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog__head">
          <h2 id="hotkeys-title">{t("hotkeys.app.title")}</h2>
          <button className="icon-button" data-autofocus aria-label={t("common.close")} onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
        </div>
        <div className="dialog--hotkeys__columns">
          <section>
            <h3>{t("hotkeys.app.section")}</h3>
            <HotkeyList section="app" />
          </section>
          <section>
            <h3>{t("hotkeys.player.section")}</h3>
            <HotkeyList section="player" />
          </section>
        </div>
      </div>
    </div>
  );
}
