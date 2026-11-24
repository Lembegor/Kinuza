import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, History, ListVideo, LoaderCircle, Pause, Play, UserRound, Users } from "lucide-react";
import { useT } from "../lib/i18n";
import { profileInitial, useProfile } from "../state/profile";
import { useProfiles } from "../state/profiles";
import { ProfileChip, ProfilesDialog } from "./ProfilesUi";

export function Avatar({ size = 34, className = "" }: { size?: number; className?: string }) {
  const { t } = useT();
  const name = useProfile((state) => state.name);
  const avatar = useProfile((state) => state.avatar);
  return (
    <span className={`avatar ${className}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {avatar ? <img src={avatar} alt="" draggable={false} /> : profileInitial(name, t("profile.defaultName"))}
    </span>
  );
}

export function ProfileButton() {
  const { t } = useT();
  const navigate = useNavigate();
  const paused = useProfile((state) => state.historyPaused);
  const name = useProfile((state) => state.name);
  const [menu, setMenu] = useState(false);
  const [managing, setManaging] = useState(false);
  const profiles = useProfiles((state) => state.view);
  const switching = useProfiles((state) => state.switching);
  const several = (profiles?.profiles.length ?? 0) > 1;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const go = (path: string) => {
    setMenu(false);
    navigate(path);
  };

  return (
    <div className="profile-button" ref={rootRef}>
      <button
        className="profile-button__avatar"
        aria-label={t("profile.open", { name: name || t("profile.defaultName") })}
        title={paused ? t("profile.paused.badge") : t("profile.title")}
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => (several ? setMenu((value) => !value) : navigate("/profile"))}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setMenu(true);
          }
        }}
      >
        <Avatar size={30} />
        {paused && (
          <span className="profile-button__paused">
            <Pause size={9} fill="currentColor" />
          </span>
        )}
      </button>
      {menu && (
        <div className="profile-menu profile-button__menu" role="menu">
          {several && profiles && (
            <>
              {profiles.profiles.map((entry) => (
                <button
                  key={entry.id}
                  role="menuitemradio"
                  aria-checked={entry.id === profiles.active}
                  className="profile-menu__person"
                  disabled={switching !== null}
                  onClick={() => {
                    if (entry.id === profiles.active) return go("/profile");
                    void useProfiles.getState().switchTo(entry.id);
                  }}
                >
                  <ProfileChip entry={entry} size={22} />
                  <span>{entry.name || t("profile.defaultName")}</span>
                  {switching === entry.id ? <LoaderCircle size={14} className="spin" /> : entry.id === profiles.active ? <Check size={14} /> : null}
                </button>
              ))}
              <hr />
            </>
          )}
          <button role="menuitem" onClick={() => go("/profile")}>
            <UserRound size={16} />
            {t("profile.title")}
          </button>
          <button role="menuitem" onClick={() => go("/profile/history")}>
            <History size={16} />
            {t("profile.tab.history")}
          </button>
          <button role="menuitem" onClick={() => go("/library")}>
            <ListVideo size={16} />
            {t("library.title")}
          </button>
          <button
            role="menuitemcheckbox"
            aria-checked={paused}
            onClick={() => {
              useProfile.getState().patch({ historyPaused: !paused });
              setMenu(false);
            }}
          >
            {paused ? <Play size={16} /> : <Pause size={16} />}
            {paused ? t("profile.paused.resume") : t("profile.paused.pause")}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setManaging(true);
            }}
          >
            <Users size={16} />
            {several ? t("profiles.manage") : t("profiles.add")}
          </button>
        </div>
      )}
      {managing && <ProfilesDialog onClose={() => setManaging(false)} />}
    </div>
  );
}
