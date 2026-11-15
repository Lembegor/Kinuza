import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlus, Trash2 } from "lucide-react";
import { useT } from "../../lib/i18n";
import { overview, allTime, type Ledger } from "../../lib/profileStats";
import { imageUrl } from "../../lib/tmdb";
import { isTopDialog, useDialogFocus } from "../../lib/useDialogFocus";
import { useLibrary } from "../../state/library";
import { profileInitial, useProfile } from "../../state/profile";
import { useUi } from "../../state/ui";

const avatarSize = 256;
const nameLimit = 40;
const coverLimit = 12;

function readAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = avatarSize;
      canvas.height = avatarSize;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("canvas"));
        return;
      }
      const side = Math.min(image.width, image.height);
      context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, avatarSize, avatarSize);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.86));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image"));
    };
    image.src = url;
  });
}

export function ProfileEdit({ ledger, onClose }: { ledger: Ledger | null; onClose: () => void }) {
  const { t } = useT();
  const profile = useProfile();
  const tracked = useLibrary((state) => state.tracked);
  const [name, setName] = useState(profile.name);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [cover, setCover] = useState(profile.cover);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useDialogFocus(dialogRef, true);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !isTopDialog(dialogRef)) return;
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const covers = useMemo(() => {
    const ranked = ledger ? overview(ledger, allTime, null, Date.now()).top.map((item) => item.key) : [];
    const keys = [...new Set([...ranked, ...Object.keys(tracked)])];
    return keys.filter((key) => tracked[key]?.backdrop).slice(0, coverLimit);
  }, [ledger, tracked]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      setAvatar(await readAvatar(file));
    } catch {
      useUi.getState().toast(t("profile.edit.badImage"), "error");
    }
  };

  const save = () => {
    profile.patch({ name: name.trim().slice(0, nameLimit), avatar, cover });
    onClose();
  };

  return createPortal(
    <div className="backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="dialog dialog--medium profile-edit"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-edit-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="profile-edit-title">{t("profile.edit.title")}</h2>
        <div className="profile-edit__row">
          <span className="avatar profile-edit__avatar">
            {avatar ? <img src={avatar} alt="" /> : profileInitial(name, t("profile.defaultName"))}
          </span>
          <div className="profile-edit__fields">
            <label className="profile-edit__label" htmlFor="profile-name">
              {t("profile.edit.name")}
            </label>
            <input
              id="profile-name"
              className="input"
              value={name}
              maxLength={nameLimit}
              placeholder={t("profile.defaultName")}
              data-autofocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") save();
              }}
            />
            <div className="profile-edit__buttons">
              <button className="button button--small" onClick={() => fileRef.current?.click()}>
                <ImagePlus size={14} />
                {t("profile.edit.picture")}
              </button>
              {avatar && (
                <button className="button button--small" onClick={() => setAvatar(null)}>
                  <Trash2 size={14} />
                  {t("profile.edit.letter")}
                </button>
              )}
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => void pick(event.target.files?.[0])} />
            </div>
          </div>
        </div>
        {covers.length > 0 && (
          <>
            <div className="profile-edit__label">{t("profile.edit.cover")}</div>
            <div className="profile-edit__covers">
              <button className={`profile-edit__cover profile-edit__cover--none ${cover === null ? "is-active" : ""}`} onClick={() => setCover(null)}>
                {t("profile.edit.noCover")}
              </button>
              {covers.map((key) => (
                <button
                  key={key}
                  className={`profile-edit__cover ${cover === key ? "is-active" : ""}`}
                  title={tracked[key]?.title}
                  aria-label={tracked[key]?.title}
                  onClick={() => setCover(key)}
                >
                  <img src={imageUrl(tracked[key]?.backdrop ?? null, "w780") ?? undefined} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          </>
        )}
        <p className="dialog__note">{t("profile.edit.note")}</p>
        <div className="dialog__actions">
          <button className="button" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="button button--primary" onClick={save}>
            {t("settings.save")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
