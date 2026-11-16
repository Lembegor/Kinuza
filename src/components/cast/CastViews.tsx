import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AudioLines,
  Captions,
  Cast,
  ChevronDown,
  ChevronUp,
  LoaderCircle,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Settings2,
  SkipForward,
  Square,
  Tv,
  Volume2,
  X,
} from "lucide-react";
import { formatClock } from "../../lib/party";
import { useT } from "../../lib/i18n";
import { languageCode, languageName } from "../../lib/languages";
import { imageUrl } from "../../lib/tmdb";
import { isTopDialog, useDialogFocus } from "../../lib/useDialogFocus";
import { hasNextEpisode, lastDeviceId, useCast } from "../../state/cast";

type Menu = "audio" | "subtitles" | "mode" | null;

export function CastPicker() {
  const { t } = useT();
  const phase = useCast((state) => state.phase);
  const devices = useCast((state) => state.devices);
  const scanning = useCast((state) => state.scanning);
  const scanned = useCast((state) => state.scanned);
  const closePicker = useCast((state) => state.closePicker);
  const scan = useCast((state) => state.scan);
  const choose = useCast((state) => state.choose);
  const dialogRef = useRef<HTMLDivElement>(null);
  const open = phase === "picking";
  useDialogFocus(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isTopDialog(dialogRef)) {
        event.stopImmediatePropagation();
        closePicker();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, closePicker]);

  if (!open) return null;
  const last = lastDeviceId();
  return createPortal(
    <div className="backdrop backdrop--top" onMouseDown={closePicker}>
      <div ref={dialogRef} className="dialog dialog--small cast-picker" role="dialog" aria-modal="true" aria-labelledby="cast-picker-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog__head">
          <h2 id="cast-picker-title">{t("cast.picker.title")}</h2>
          <button className="icon-button" aria-label={t("cast.picker.refresh")} title={t("cast.picker.refresh")} disabled={scanning} onClick={() => void scan()}>
            <RefreshCw size={16} className={scanning ? "spin" : ""} />
          </button>
          <button className="icon-button" aria-label={t("common.close")} onClick={closePicker}>
            <X size={18} />
          </button>
        </div>
        <div className="cast-picker__list">
          {devices.map((device) => (
            <button key={device.id} className="cast-device" data-autofocus={device.id === last ? true : undefined} onClick={() => void choose(device)}>
              <span className="cast-device__icon">
                <Tv size={20} />
              </span>
              <span className="cast-device__text">
                <b>{device.name}</b>
                <small>{[device.maker, device.model].filter(Boolean).join(" · ") || device.address}</small>
              </span>
              {device.id === last && <span className="cast-device__badge">{t("cast.picker.recent")}</span>}
            </button>
          ))}
          {scanning && (
            <div className="cast-picker__searching">
              <LoaderCircle size={16} className="spin" />
              {t("cast.picker.searching")}
            </div>
          )}
          {!scanning && scanned && devices.length === 0 && (
            <div className="cast-picker__empty">
              <b>{t("cast.picker.none")}</b>
              <ul>
                <li>{t("cast.picker.tipNetwork")}</li>
                <li>{t("cast.picker.tipDlna")}</li>
                <li>{t("cast.picker.tipFirewall")}</li>
              </ul>
            </div>
          )}
        </div>
        <p className="cast-picker__note">{t("cast.picker.note")}</p>
      </div>
    </div>,
    document.body,
  );
}

function stateText(t: ReturnType<typeof useT>["t"], phase: string, state: string | undefined, busy: string | null): string {
  if (busy === "seek" || phase === "starting") return t("cast.state.starting");
  if (state === "PLAYING") return t("cast.state.playing");
  if (state === "PAUSED_PLAYBACK") return t("cast.state.paused");
  if (state === "TRANSITIONING") return t("cast.state.loading");
  if (state === "STOPPED" || state === "NO_MEDIA_PRESENT") return t("cast.state.stopped");
  return t("cast.state.starting");
}

function SeekLine({ position, duration, onSeek }: { position: number; duration: number; onSeek: (value: number) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? position;
  const share = duration > 0 ? Math.min(1, shown / duration) : 0;
  const valueAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * duration;
  };
  return (
    <div className="cast-seek">
      <span>{formatClock(shown)}</span>
      <div
        className="cast-seek__track"
        onPointerDown={(event) => {
          if (duration <= 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag(valueAt(event));
        }}
        onPointerMove={(event) => {
          if (drag !== null) setDrag(valueAt(event));
        }}
        onPointerUp={(event) => {
          if (drag === null) return;
          onSeek(valueAt(event));
          setDrag(null);
        }}
      >
        <i style={{ width: `${share * 100}%` }} />
        <b style={{ left: `${share * 100}%` }} />
      </div>
      <span>{duration > 0 ? formatClock(duration) : "--:--"}</span>
    </div>
  );
}

function CastMenus({ menu, setMenu }: { menu: Menu; setMenu: (menu: Menu) => void }) {
  const { t, locale } = useT();
  const job = useCast((state) => state.job);
  const level = useCast((state) => state.level);
  const chooseAudio = useCast((state) => state.chooseAudio);
  const chooseSubtitle = useCast((state) => state.chooseSubtitle);
  const setBurn = useCast((state) => state.setBurn);
  const setLevel = useCast((state) => state.setLevel);
  if (!job || !menu) return null;
  const tracks = job.tracks;
  const pick = (action: () => Promise<void>) => {
    setMenu(null);
    void action();
  };
  if (menu === "audio") {
    return (
      <div className="cast-menu">
        <b className="cast-menu__title">{t("player.audioTrack")}</b>
        {(tracks?.audio ?? []).map((track) => (
          <button key={track.index} className={`cast-menu__item ${job.audio === track.index || (job.audio === null && track.isDefault) ? "is-on" : ""}`} onClick={() => pick(() => chooseAudio(track.index))}>
            <span>{track.title || languageName(languageCode(track.language), locale) || t("cast.track.number", { number: track.index + 1 })}</span>
            <small>{[languageName(languageCode(track.language), locale), track.codec.toUpperCase(), track.channels].filter(Boolean).join(" · ")}</small>
          </button>
        ))}
        {(tracks?.audio.length ?? 0) === 0 && <p className="cast-menu__empty">{t("cast.track.unknown")}</p>}
      </div>
    );
  }
  if (menu === "subtitles") {
    const external = job.subtitle?.kind === "external";
    return (
      <div className="cast-menu">
        <b className="cast-menu__title">{t("common.subtitles")}</b>
        <button className={`cast-menu__item ${!job.subtitle || job.subtitle.kind === "none" ? "is-on" : ""}`} onClick={() => pick(() => chooseSubtitle(null, ""))}>
          <span>{t("cast.subtitles.off")}</span>
        </button>
        {(tracks?.subtitles ?? []).map((track) => (
          <button
            key={track.index}
            className={`cast-menu__item ${job.subtitle?.kind === "internal" && job.subtitle.index === track.index ? "is-on" : ""}`}
            onClick={() => pick(() => chooseSubtitle({ kind: "internal", index: track.index, text: track.isText }, track.title || languageName(languageCode(track.language), locale)))}
          >
            <span>{track.title || languageName(languageCode(track.language), locale) || t("cast.track.number", { number: track.index + 1 })}</span>
            <small>{[languageName(languageCode(track.language), locale), track.isText ? t("cast.subtitles.text") : t("cast.subtitles.picture")].filter(Boolean).join(" · ")}</small>
          </button>
        ))}
        {external && (
          <button className="cast-menu__item is-on">
            <span>{job.subtitleLabel || t("cast.subtitles.yours")}</span>
            <small>{t("cast.subtitles.fromComputer")}</small>
          </button>
        )}
        <label className="check cast-menu__burn">
          <input type="checkbox" checked={job.burn} disabled={!job.subtitle || job.subtitle.kind === "none" || (job.subtitle.kind === "internal" && job.subtitle.text === true)} onChange={(event) => pick(() => setBurn(event.target.checked))} />
          <span>
            {t("cast.subtitles.burn")}
            <small>{job.subtitle?.kind === "internal" && job.subtitle.text ? t("cast.subtitles.burnText") : t("cast.subtitles.burnNote")}</small>
          </span>
        </label>
      </div>
    );
  }
  const modes = [0, 1, 2, 3] as const;
  return (
    <div className="cast-menu">
      <b className="cast-menu__title">{t("cast.mode.title")}</b>
      {modes.map((mode) => (
        <button key={mode} className={`cast-menu__item ${level === mode ? "is-on" : ""}`} onClick={() => pick(() => setLevel(mode))}>
          <span>{t(`cast.mode.${mode}`)}</span>
          <small>{t(`cast.mode.${mode}.note`)}</small>
        </button>
      ))}
    </div>
  );
}

export function CastPlayer() {
  const { t } = useT();
  const phase = useCast((state) => state.phase);
  const job = useCast((state) => state.job);
  const device = useCast((state) => state.device);
  const status = useCast((state) => state.status);
  const position = useCast((state) => state.position);
  const playing = useCast((state) => state.playing);
  const busy = useCast((state) => state.busy);
  const error = useCast((state) => state.error);
  const expanded = useCast((state) => state.expanded);
  const nextIn = useCast((state) => state.nextIn);
  const { togglePause, seek, setVolume, backToComputer, stop, playNext, cancelNext, setExpanded } = useCast.getState();
  const [menu, setMenu] = useState<Menu>(null);
  const [volume, setVolumeShown] = useState<number | null>(null);

  useEffect(() => {
    if (!expanded || (phase !== "casting" && phase !== "starting" && phase !== "failed")) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (document.querySelector(".backdrop")) return;
      if (event.key === " " || event.key === "k") {
        event.preventDefault();
        void togglePause();
      } else if (event.key === "ArrowLeft") void seek(useCast.getState().position - (event.shiftKey ? 30 : 10));
      else if (event.key === "ArrowRight") void seek(useCast.getState().position + (event.shiftKey ? 30 : 10));
      else if (event.key === "Escape") {
        if (menu) setMenu(null);
        else setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, phase, menu]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!job || !device || (phase !== "casting" && phase !== "starting" && phase !== "failed")) return null;
  const duration = job.duration || status?.duration || 0;
  const title = job.session.title.title;
  const episode = job.session.episode !== undefined ? t("title.episodeShort", { season: job.session.season ?? 0, episode: job.session.episode }) : job.session.title.year;
  const backdrop = imageUrl(job.session.title.backdrop ?? job.session.title.poster, "w1280");
  const poster = imageUrl(job.session.title.poster, "w342");
  const shownVolume = volume ?? status?.volume ?? null;

  if (!expanded) {
    return createPortal(
      <div className="cast-mini" role="region" aria-label={t("cast.title")}>
        <button className="cast-mini__open" onClick={() => setExpanded(true)}>
          <Cast size={16} />
          <span>
            <b>{title}</b>
            <small>{t("cast.mini.on", { device: device.name })}</small>
          </span>
          <ChevronUp size={16} />
        </button>
        <button className="icon-button" aria-label={playing ? t("player.pause") : t("player.play")} onClick={() => void togglePause()} disabled={phase !== "casting"}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button className="icon-button" aria-label={t("cast.stop")} title={t("cast.stop")} onClick={() => void stop()}>
          <Square size={14} />
        </button>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="cast-player" role="dialog" aria-label={t("cast.title")}>
      {backdrop && <div className="cast-player__backdrop" style={{ backgroundImage: `url('${backdrop}')` }} />}
      <div className="cast-player__top">
        <button className="icon-button" aria-label={t("cast.collapse")} title={t("cast.collapse")} onClick={() => setExpanded(false)}>
          <ChevronDown size={20} />
        </button>
        <span className="cast-player__device">
          <Tv size={15} />
          {t("cast.on", { device: device.name })}
        </span>
      </div>
      <div className="cast-player__body">
        {poster && <img className="cast-player__poster" src={poster} alt="" draggable={false} />}
        <div className="cast-player__info">
          <h2>{title}</h2>
          {episode && <span className="cast-player__episode">{episode}</span>}
          <span className={`cast-player__state ${phase === "failed" ? "is-error" : ""}`}>
            {phase === "failed" ? error : error ? error : stateText(t, phase, status?.state, busy)}
            {(phase === "starting" || busy) && phase !== "failed" && <LoaderCircle size={14} className="spin" />}
          </span>
          {phase === "failed" && (
            <div className="cast-player__failed">
              <button className="button button--small" onClick={() => void useCast.getState().setLevel(0)}>
                <RotateCcw size={14} />
                {t("common.retry")}
              </button>
              <button className="button button--small" onClick={() => void backToComputer()}>
                <Monitor size={14} />
                {t("cast.back")}
              </button>
            </div>
          )}
          {nextIn !== null && (
            <div className="cast-player__next">
              <span>{t("cast.next.in", { seconds: nextIn })}</span>
              <button className="button button--small button--primary" onClick={() => void playNext()}>
                <SkipForward size={14} />
                {t("cast.next.now")}
              </button>
              <button className="button button--small" onClick={cancelNext}>
                {t("common.cancel")}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="cast-player__controls">
        <SeekLine position={position} duration={duration} onSeek={(value) => void seek(value)} />
        <div className="cast-player__buttons">
          <button className="icon-button" aria-label={t("cast.back30")} title={t("cast.back30")} onClick={() => void seek(position - 30)}>
            <RotateCcw size={20} />
          </button>
          <button className="cast-player__play" aria-label={playing ? t("player.pause") : t("player.play")} disabled={phase !== "casting"} onClick={() => void togglePause()}>
            {playing ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
          </button>
          <button className="icon-button" aria-label={t("cast.forward30")} title={t("cast.forward30")} onClick={() => void seek(position + 30)}>
            <RotateCw size={20} />
          </button>
          {hasNextEpisode() && (
            <button className="icon-button" aria-label={t("cast.next.now")} title={t("cast.next.now")} onClick={() => void playNext()}>
              <SkipForward size={20} />
            </button>
          )}
          <span className="cast-player__spacer" />
          {shownVolume !== null && (
            <label className="cast-player__volume" title={t("player.volume")}>
              <Volume2 size={18} />
              <input
                type="range"
                min={0}
                max={100}
                value={shownVolume}
                onChange={(event) => setVolumeShown(Number(event.target.value))}
                onPointerUp={(event) => {
                  void setVolume(Number((event.target as HTMLInputElement).value));
                  setVolumeShown(null);
                }}
                onKeyUp={(event) => {
                  void setVolume(Number((event.target as HTMLInputElement).value));
                  setVolumeShown(null);
                }}
              />
            </label>
          )}
          <div className="cast-player__menus">
            <button className={`icon-button ${menu === "audio" ? "is-on" : ""}`} aria-label={t("player.audioTrack")} title={t("player.audioTrack")} onClick={() => setMenu(menu === "audio" ? null : "audio")}>
              <AudioLines size={19} />
            </button>
            <button className={`icon-button ${menu === "subtitles" ? "is-on" : ""}`} aria-label={t("common.subtitles")} title={t("common.subtitles")} onClick={() => setMenu(menu === "subtitles" ? null : "subtitles")}>
              <Captions size={19} />
            </button>
            <button className={`icon-button ${menu === "mode" ? "is-on" : ""}`} aria-label={t("cast.mode.title")} title={t("cast.mode.title")} onClick={() => setMenu(menu === "mode" ? null : "mode")}>
              <Settings2 size={19} />
            </button>
            <CastMenus menu={menu} setMenu={setMenu} />
          </div>
          <button className="button button--small" onClick={() => void backToComputer()}>
            <Monitor size={14} />
            {t("cast.back")}
          </button>
          <button className="button button--small" onClick={() => void stop()}>
            <Square size={13} />
            {t("cast.stop")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
