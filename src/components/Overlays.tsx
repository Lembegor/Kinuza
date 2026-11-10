// Small global overlays: toasts, the confirm dialog and the update notice.

import { useEffect, useState } from "react";
import { CircleAlert, CircleCheck, Info, RefreshCw, X } from "lucide-react";
import { useUi } from "../state/ui";
import { useUpdater } from "../state/updater";

const toastIcons = { info: Info, success: CircleCheck, error: CircleAlert };

export function Toasts() {
  const toasts = useUi((state) => state.toasts);
  const dismiss = useUi((state) => state.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((toast) => {
        const Icon = toastIcons[toast.kind];
        return (
          <div key={toast.id} className={`toast toast--${toast.kind}`} onClick={() => dismiss(toast.id)}>
            <Icon size={18} />
            <span>{toast.text}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ConfirmDialog() {
  const request = useUi((state) => state.confirm);
  const close = useUi((state) => state.closeConfirm);
  const [optionChecked, setOptionChecked] = useState(false);

  useEffect(() => setOptionChecked(false), [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, close]);

  if (!request) return null;
  return (
    <div className="backdrop" onMouseDown={close}>
      <div className="dialog dialog--small" onMouseDown={(event) => event.stopPropagation()}>
        <h2>{request.title}</h2>
        <p className="dialog__text">{request.message}</p>
        {request.optionLabel && (
          <label className="check">
            <input type="checkbox" checked={optionChecked} onChange={(event) => setOptionChecked(event.target.checked)} />
            <span>{request.optionLabel}</span>
          </label>
        )}
        <div className="dialog__actions">
          <button className="button" onClick={close}>
            Отмена
          </button>
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
  const visible = (status === "available" && !dismissed) || status === "downloading" || status === "installing";
  if (!visible) return null;

  return (
    <div className="update-notice">
      <div className="update-notice__head">
        <RefreshCw size={18} className={status === "available" ? "" : "spin"} />
        <strong>Kinuza {version}</strong>
        {status === "available" && (
          <button className="icon-button" aria-label="Позже" onClick={dismiss}>
            <X size={15} />
          </button>
        )}
      </div>
      {status === "available" && (
        <>
          <p>{notes.trim() || "Доступна новая версия приложения."}</p>
          <button className="button button--primary button--block" onClick={() => void install()}>
            Обновить и перезапустить
          </button>
        </>
      )}
      {status !== "available" && (
        <>
          <p>{status === "installing" ? "Устанавливаем…" : `Скачиваем… ${Math.round(progress * 100)}%`}</p>
          <div className="bar">
            <i style={{ width: `${progress * 100}%` }} />
          </div>
        </>
      )}
    </div>
  );
}
