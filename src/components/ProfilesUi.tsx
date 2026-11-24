import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import type { ProfileEntry } from "../lib/backend";
import { describeError } from "../lib/backend";
import { useT } from "../lib/i18n";
import { isTopDialog, useDialogFocus } from "../lib/useDialogFocus";
import { notePicked, pickedThisRun, profileColors, useProfiles, type ProfileColor } from "../state/profiles";
import { useUi } from "../state/ui";

const maxProfiles = 8;

function initialOf(name: string, fallback: string): string {
  return (name.trim() || fallback).charAt(0).toLocaleUpperCase();
}

export function ProfileChip({ entry, size = 34 }: { entry: Pick<ProfileEntry, "name" | "avatar" | "color">; size?: number }) {
  const { t } = useT();
  return (
    <span className={`profile-chip is-${entry.color}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {entry.avatar ? <img src={entry.avatar} alt="" draggable={false} /> : initialOf(entry.name, t("profile.defaultName"))}
    </span>
  );
}

function ColorPicker({ value, onChange }: { value: ProfileColor; onChange: (color: ProfileColor) => void }) {
  const { t } = useT();
  return (
    <div className="profile-colors" role="radiogroup" aria-label={t("profiles.color")}>
      {profileColors.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={t(`profiles.colors.${color}`)}
          className={`profile-colors__dot is-${color} ${value === color ? "is-on" : ""}`}
          onClick={() => onChange(color)}
        >
          {value === color && <Check size={13} />}
        </button>
      ))}
    </div>
  );
}

function NewProfileForm({ onDone, onCancel }: { onDone: (id: string) => void; onCancel?: () => void }) {
  const { t } = useT();
  const count = useProfiles((state) => state.view?.profiles.length ?? 1);
  const [name, setName] = useState("");
  const [color, setColor] = useState<ProfileColor>(profileColors[(count * 3) % profileColors.length]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setProblem("");
    try {
      onDone(await useProfiles.getState().create(name.trim(), color));
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="profile-new"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="profile-new__row">
        <ProfileChip entry={{ name, avatar: null, color }} size={48} />
        <input
          className="input"
          autoFocus
          maxLength={40}
          placeholder={t("profiles.namePlaceholder")}
          aria-label={t("profiles.name")}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <ColorPicker value={color} onChange={setColor} />
      {problem && <p className="profile-new__problem">{problem}</p>}
      <div className="dialog__actions">
        {onCancel && (
          <button type="button" className="button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        )}
        <button type="submit" className="button button--primary" disabled={!name.trim() || busy}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}
          {t("profiles.create")}
        </button>
      </div>
    </form>
  );
}

export function WhoIsWatching() {
  const { t } = useT();
  const view = useProfiles((state) => state.view);
  const switching = useProfiles((state) => state.switching);
  const [hidden, setHidden] = useState(() => pickedThisRun());
  const [eligible, setEligible] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (view && eligible === null) setEligible(view.ask && view.profiles.length > 1);
  }, [view, eligible]);

  const shown = !hidden && eligible === true && view !== null && view.profiles.length > 1;

  useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !adding) {
        notePicked();
        setHidden(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, adding]);

  if (!shown || !view) return null;
  const choose = async (id: string) => {
    setProblem("");
    if (id === view.active) {
      notePicked();
      setHidden(true);
      return;
    }
    try {
      await useProfiles.getState().switchTo(id);
    } catch (error) {
      setProblem(describeError(error));
    }
  };
  return (
    <div className="who-watches" role="dialog" aria-modal="true" aria-label={t("profiles.who")}>
      <div className="who-watches__inner">
        <h1>{t("profiles.who")}</h1>
        {adding ? (
          <div className="who-watches__new">
            <NewProfileForm onDone={(id) => void choose(id)} onCancel={() => setAdding(false)} />
          </div>
        ) : (
          <div className="who-watches__grid">
            {view.profiles.map((entry) => (
              <button key={entry.id} className="who-watches__tile" disabled={switching !== null} onClick={() => void choose(entry.id)}>
                <ProfileChip entry={entry} size={112} />
                <span>{entry.name || t("profile.defaultName")}</span>
                {switching === entry.id && <LoaderCircle size={18} className="spin" />}
              </button>
            ))}
            {view.profiles.length < maxProfiles && (
              <button className="who-watches__tile is-add" disabled={switching !== null} onClick={() => setAdding(true)}>
                <span className="who-watches__plus">
                  <Plus size={40} />
                </span>
                <span>{t("profiles.addShort")}</span>
              </button>
            )}
          </div>
        )}
        {problem && <p className="who-watches__problem">{problem}</p>}
        <label className="who-watches__ask">
          <input type="checkbox" checked={view.ask} onChange={(event) => void useProfiles.getState().setAsk(event.target.checked)} />
          {t("profiles.askOnStart")}
        </label>
      </div>
    </div>
  );
}

function ProfileRow({ entry, active }: { entry: ProfileEntry; active: boolean }) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entry.name);
  const [color, setColor] = useState<ProfileColor>((profileColors as readonly string[]).includes(entry.color) ? (entry.color as ProfileColor) : "blue");
  const askConfirm = useUi((state) => state.askConfirm);
  const toast = useUi((state) => state.toast);
  const save = async () => {
    try {
      await useProfiles.getState().update(entry.id, { name: name.trim(), color });
      setEditing(false);
    } catch (error) {
      toast(describeError(error), "error");
    }
  };
  if (editing) {
    return (
      <li className="profiles-list__item is-editing">
        <div className="profile-new__row">
          <ProfileChip entry={{ ...entry, name, color }} size={40} />
          <input className="input" autoFocus maxLength={40} aria-label={t("profiles.name")} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <ColorPicker value={color} onChange={setColor} />
        <div className="dialog__actions">
          <button className="button" onClick={() => setEditing(false)}>
            {t("common.cancel")}
          </button>
          <button className="button button--primary" disabled={!name.trim()} onClick={() => void save()}>
            {t("profiles.save")}
          </button>
        </div>
      </li>
    );
  }
  return (
    <li className="profiles-list__item">
      <ProfileChip entry={entry} size={40} />
      <span className="profiles-list__text">
        <b>{entry.name || t("profile.defaultName")}</b>
        <small>{active ? t("profiles.current") : entry.main ? t("profiles.main") : t("profiles.other")}</small>
      </span>
      <button className="icon-button" aria-label={t("profiles.edit")} title={t("profiles.edit")} onClick={() => setEditing(true)}>
        <Pencil size={15} />
      </button>
      {!entry.main && !active && (
        <button
          className="icon-button"
          aria-label={t("profiles.remove")}
          title={t("profiles.remove")}
          onClick={() =>
            askConfirm({
              title: t("profiles.remove.title", { name: entry.name }),
              message: t("profiles.remove.text"),
              confirmLabel: t("profiles.remove"),
              danger: true,
              onConfirm: () => {
                useProfiles
                  .getState()
                  .remove(entry.id)
                  .catch((error) => toast(describeError(error), "error"));
              },
            })
          }
        >
          <Trash2 size={15} />
        </button>
      )}
    </li>
  );
}

export function ProfilesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const view = useProfiles((state) => state.view);
  const [adding, setAdding] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef);

  useEffect(() => {
    void useProfiles.getState().load();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isTopDialog(dialogRef)) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="dialog dialog--small profiles-dialog" role="dialog" aria-modal="true" aria-label={t("profiles.manage")} tabIndex={-1}>
        <div className="dialog__head">
          <div>
            <h2>{t("profiles.manage")}</h2>
            <p className="dialog__text">{t("profiles.manage.text")}</p>
          </div>
          <button className="icon-button" aria-label={t("common.close")} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <ul className="profiles-list">
          {view?.profiles.map((entry) => <ProfileRow key={entry.id} entry={entry} active={entry.id === view.active} />)}
        </ul>
        {adding ? (
          <NewProfileForm onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
        ) : (
          view &&
          view.profiles.length < maxProfiles && (
            <button className="button profiles-dialog__add" onClick={() => setAdding(true)}>
              <Plus size={15} />
              {t("profiles.add")}
            </button>
          )
        )}
        {view && view.profiles.length > 1 && (
          <label className="who-watches__ask is-inline">
            <input type="checkbox" checked={view.ask} onChange={(event) => void useProfiles.getState().setAsk(event.target.checked)} />
            {t("profiles.askOnStart")}
          </label>
        )}
      </div>
    </div>
  );
}
