// Full-window player: streams a torrent file while it downloads, switches quality between sources,
// audio tracks, subtitles, resume and next episode.

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowLeft,
  AudioLines,
  Captions,
  Check,
  ExternalLink,
  Gauge,
  LoaderCircle,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings2,
  SkipForward,
  TriangleAlert,
  Users,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import { backend, describeError, getAppInfo, isDesktop, streamUrl, type TorrentFile } from "../lib/backend";
import { formatBytes, formatClock, formatSpeed } from "../lib/format";
import { baseName, isSubtitleFile, qualityFromSize, qualityRank } from "../lib/parse";
import {
  activeCueText,
  compareSubtitleLabels,
  decodeSubtitleBytes,
  describeSubtitleFile,
  parseSubtitles,
  type Cue,
  type SubtitleLabel,
} from "../lib/subtitles";
import { tmdb } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { sortSources } from "../pages/Title";
import { isWatched, unitKey, useLibrary, type Source } from "../state/library";
import { useSettings } from "../state/settings";
import { fileProgress, useTorrents } from "../state/torrents";
import { useUi, type PlayerSession } from "../state/ui";
import { WindowButtons } from "./Shell";

const controlsHideDelayMs = 3000;
const progressSaveIntervalMs = 5000;
const seekStepSeconds = 10;
const volumeStep = 0.05;
/** Positions before this are not worth resuming from. */
const minResumeSeconds = 15;
const nextEpisodeCountdownSeconds = 8;
const silentAudioCheckDelayMs = 5000;
const settingsSaveDelayMs = 400;
const maxTorrentSubtitles = 12;
const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2];
const subtitleScales = [
  { label: "Мелкие", value: 0.8 },
  { label: "Обычные", value: 1 },
  { label: "Крупные", value: 1.3 },
];

type Menu = "quality" | "audio" | "subtitles" | "speed" | null;

/** The slice of the non-standard AudioTrackList API this player relies on. */
interface AudioTrackLike {
  label: string;
  language: string;
  enabled: boolean;
}

interface AudioOption {
  index: number;
  label: string;
}

type VideoWithExtras = HTMLVideoElement & {
  audioTracks?: ArrayLike<AudioTrackLike>;
  webkitAudioDecodedByteCount?: number;
};

interface SubtitleOption extends SubtitleLabel {
  key: string;
  file: TorrentFile;
}

/**
 * Picks where playback starts: an explicit choice, else the preferred quality, else the best copy.
 * `sources` is sorted best first; `maxQuality` 0 means no limit.
 */
function pickInitialSource(sources: Source[], preferredId: string | undefined, maxQuality: number): Source | undefined {
  const preferred = sources.find((source) => source.id === preferredId);
  if (preferred || sources.length === 0) return preferred;
  const { byHash } = useTorrents.getState();
  const isReady = (source: Source) => fileProgress(byHash[source.infoHash], source.fileIndex) >= 1;

  if (maxQuality > 0) {
    const within = sources.filter((source) => qualityRank(source.quality) <= maxQuality);
    // Everything is above the limit: the lowest one is the closest match.
    const pool = within.length > 0 ? within : sources.slice(-1);
    const top = qualityRank(pool[0].quality);
    const sameQuality = pool.filter((source) => qualityRank(source.quality) === top);
    return sameQuality.find(isReady) ?? sameQuality[0];
  }
  // A fully downloaded copy starts instantly, so it wins over a better one still downloading.
  return sources.find(isReady) ?? sources[0];
}

function readAudioOptions(video: VideoWithExtras): { options: AudioOption[]; selected: number } {
  const tracks = video.audioTracks;
  if (!tracks || tracks.length < 2) return { options: [], selected: 0 };
  const options: AudioOption[] = [];
  let selected = 0;
  for (let index = 0; index < tracks.length; index++) {
    const track = tracks[index];
    if (track.enabled) selected = index;
    const name = [track.label, track.language].filter(Boolean).join(" · ");
    options.push({ index, label: name || `Дорожка ${index + 1}` });
  }
  return { options, selected };
}

function torrentSubtitleFiles(files: TorrentFile[], videoFileName: string): TorrentFile[] {
  const subtitles = files.filter((file) => isSubtitleFile(file.path));
  const stem = videoFileName.replace(/\.[^.]+$/, "").toLowerCase();
  const matching = subtitles.filter((file) => baseName(file.path).toLowerCase().startsWith(stem));
  if (matching.length > 0) return matching;
  return subtitles.length <= maxTorrentSubtitles ? subtitles : [];
}

async function setWindowFullscreen(fullscreen: boolean, fallback: HTMLElement | null): Promise<void> {
  if (isDesktop) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFullscreen(fullscreen);
    return;
  }
  if (fullscreen) await fallback?.requestFullscreen?.();
  else if (document.fullscreenElement) await document.exitFullscreen();
}

function SeekBar({
  current,
  duration,
  buffered,
  onSeek,
}: {
  current: number;
  duration: number;
  buffered: { start: number; end: number }[];
  onSeek: (time: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);

  const ratioAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  // Seeking a torrent re-prioritises pieces, so it happens once on release, not while dragging.
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag(ratioAt(event.clientX));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const ratio = ratioAt(event.clientX);
    setHover(ratio);
    if (drag !== null) setDrag(ratio);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    onSeek(ratioAt(event.clientX) * duration);
    setDrag(null);
  };

  const safeDuration = duration > 0 ? duration : 1;
  const playedRatio = drag ?? current / safeDuration;

  return (
    <div
      className={`seek ${drag !== null ? "is-dragging" : ""}`}
      ref={trackRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
    >
      <div className="seek__track">
        {buffered.map((range) => (
          <i
            key={range.start}
            className="seek__buffered"
            style={{ left: `${(range.start / safeDuration) * 100}%`, width: `${((range.end - range.start) / safeDuration) * 100}%` }}
          />
        ))}
        <i className="seek__played" style={{ width: `${playedRatio * 100}%` }} />
        <i className="seek__thumb" style={{ left: `${playedRatio * 100}%` }} />
      </div>
      {hover !== null && duration > 0 && (
        <span className="seek__tooltip" style={{ left: `${hover * 100}%` }}>
          {formatClock(hover * duration)}
        </span>
      )}
    </div>
  );
}

function PlayerView({ session }: { session: PlayerSession }) {
  const videoRef = useRef<VideoWithExtras>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const closePlayer = useUi((state) => state.closePlayer);
  const play = useUi((state) => state.play);
  const toast = useUi((state) => state.toast);
  const settings = useSettings();

  const stored = useLibrary((state) => state.sources[session.unitKey]);
  const allSources = useLibrary((state) => state.sources);
  const sources = useMemo(() => sortSources(stored ?? []), [stored]);
  const [sourceId, setSourceId] = useState(() => pickInitialSource(sources, session.preferredSourceId, settings.preferredQuality)?.id);
  const source = sources.find((item) => item.id === sourceId) ?? sources[0];
  const torrent = useTorrents((state) => (source ? state.byHash[source.infoHash] : undefined));

  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState<{ start: number; end: number }[]>([]);
  const [failed, setFailed] = useState(false);
  const [silentAudio, setSilentAudio] = useState(false);
  const [ended, setEnded] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [rate, setRate] = useState(1);
  const [audio, setAudio] = useState<{ options: AudioOption[]; selected: number }>({ options: [], selected: 0 });
  const [cues, setCues] = useState<Cue[]>([]);
  const [subtitleKey, setSubtitleKey] = useState<string | null>(null);
  const [subtitleLabel, setSubtitleLabel] = useState("");
  const [resolution, setResolution] = useState("");
  const [subtitleText, setSubtitleText] = useState("");
  const [volume, setVolume] = useState(settings.volume);
  const [muted, setMuted] = useState(settings.muted);
  const externalPlayer = useAsync(getAppInfo, []).data?.externalPlayer ?? null;

  /** Where playback should start once metadata arrives: saved progress or the spot before a quality switch. */
  const resumeAt = useRef<number>(
    (() => {
      const saved = useLibrary.getState().progress[session.unitKey];
      return saved && !isWatched(saved) && saved.position >= minResumeSeconds ? saved.position : 0;
    })(),
  );

  const seasonEpisodes = useAsync(
    () => (session.season !== undefined ? tmdb.season(session.title.id, session.season) : Promise.resolve([])),
    [session.title.id, session.season],
  );
  const nextEpisode = useMemo(() => {
    if (session.episode === undefined) return null;
    const next = (seasonEpisodes.data ?? []).find((episode) => episode.episode === session.episode! + 1);
    if (!next) return null;
    return allSources[unitKey("tv", session.title.id, next.season, next.episode)] ? next : null;
  }, [seasonEpisodes.data, allSources, session]);

  const subtitleOptions = useMemo<SubtitleOption[]>(() => {
    if (!torrent || !source) return [];
    return torrentSubtitleFiles(torrent.files, source.fileName)
      .map((file) => ({
        file,
        key: `torrent:${file.index}`,
        ...describeSubtitleFile(baseName(file.path), source.fileName),
      }))
      .sort(compareSubtitleLabels);
  }, [torrent, source]);

  // --- source and playback lifecycle -------------------------------------------------------------

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    setSilentAudio(false);
    setBuffering(true);
    void streamUrl(source.infoHash, source.fileIndex).then((value) => {
      if (!cancelled) setUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [source?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveProgress = useCallback(() => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0 || video.currentTime < 1) return;
    useLibrary.getState().setProgress(session.unitKey, {
      position: video.currentTime,
      duration: video.duration,
      updatedAt: Date.now(),
      title: session.title,
      season: session.season,
      episode: session.episode,
      episodeName: session.episodeName,
    });
  }, [session]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(saveProgress, progressSaveIntervalMs);
    return () => clearInterval(timer);
  }, [playing, saveProgress]);

  // Leaving the player keeps the position and returns the window from fullscreen.
  useEffect(
    () => () => {
      saveProgress();
      void setWindowFullscreen(false, null);
    },
    [saveProgress],
  );

  const close = useCallback(() => {
    saveProgress();
    closePlayer();
  }, [saveProgress, closePlayer]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, []);

  const seekTo = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.5));
    setCurrent(video.currentTime);
    setEnded(false);
    setCountdown(null);
  }, []);

  const seekBy = useCallback((delta: number) => seekTo((videoRef.current?.currentTime ?? 0) + delta), [seekTo]);

  const switchSource = (next: Source) => {
    if (next.id === source?.id) return;
    resumeAt.current = videoRef.current?.currentTime ?? 0;
    setSourceId(next.id);
    setMenu(null);
  };

  const playNext = useCallback(() => {
    if (!nextEpisode) return;
    saveProgress();
    play({
      title: session.title,
      unitKey: unitKey("tv", session.title.id, nextEpisode.season, nextEpisode.episode),
      season: nextEpisode.season,
      episode: nextEpisode.episode,
      episodeName: nextEpisode.name,
    });
  }, [nextEpisode, play, saveProgress, session.title]);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((value) => {
      void setWindowFullscreen(!value, rootRef.current);
      return !value;
    });
  }, []);

  // --- volume ------------------------------------------------------------------------------------

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.volume = volume;
      video.muted = muted;
    }
    const timer = setTimeout(() => useSettings.getState().patch({ volume, muted }), settingsSaveDelayMs);
    return () => clearTimeout(timer);
  }, [volume, muted, url]);

  const changeVolume = useCallback((delta: number) => {
    setMuted(false);
    setVolume((value) => Math.min(1, Math.max(0, Math.round((value + delta) * 100) / 100)));
  }, []);

  // --- controls visibility -----------------------------------------------------------------------

  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wakeControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControlsVisible(false), controlsHideDelayMs);
  }, []);

  useEffect(() => {
    wakeControls();
    return () => clearTimeout(hideTimer.current);
  }, [wakeControls]);

  const controlsShown = controlsVisible || !playing || menu !== null || failed;

  // --- keyboard ----------------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // A dialog opened over the player (a link arriving from the browser) keeps its own typing.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      const handlers: Record<string, () => void> = {
        " ": togglePlay,
        k: togglePlay,
        ArrowLeft: () => seekBy(-seekStepSeconds),
        ArrowRight: () => seekBy(seekStepSeconds),
        ArrowUp: () => changeVolume(volumeStep),
        ArrowDown: () => changeVolume(-volumeStep),
        f: toggleFullscreen,
        m: () => setMuted((value) => !value),
        n: playNext,
        Escape: () => {
          if (menu) setMenu(null);
          else if (fullscreen) toggleFullscreen();
          else close();
        },
      };
      const handler = handlers[event.key] ?? handlers[event.key.toLowerCase()];
      if (!handler) return;
      event.preventDefault();
      handler();
      wakeControls();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekBy, changeVolume, toggleFullscreen, playNext, close, menu, fullscreen, wakeControls]);

  // --- subtitles ---------------------------------------------------------------------------------

  useEffect(() => {
    if (cues.length === 0) {
      setSubtitleText("");
      return;
    }
    let frame = 0;
    const update = () => {
      const text = activeCueText(cues, videoRef.current?.currentTime ?? 0);
      setSubtitleText((previous) => (previous === text ? previous : text));
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [cues]);

  const applySubtitles = (bytes: ArrayBuffer, key: string, label: string) => {
    const parsed = parseSubtitles(decodeSubtitleBytes(bytes));
    if (parsed.length === 0) {
      toast("В файле не нашлось субтитров.", "error");
      return;
    }
    setCues(parsed);
    setSubtitleKey(key);
    setSubtitleLabel(label);
    setMenu(null);
  };

  const loadTorrentSubtitle = async (option: SubtitleOption) => {
    if (!source) return;
    try {
      const response = await fetch(await streamUrl(source.infoHash, option.file.index));
      if (!response.ok) throw new Error("file_unreadable");
      applySubtitles(await response.arrayBuffer(), option.key, option.label);
    } catch (error) {
      toast(describeError(error), "error");
    }
  };

  const loadSubtitleFromDisk = async () => {
    if (!isDesktop) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ title: "Файл субтитров", filters: [{ name: "Субтитры", extensions: ["srt", "ass", "ssa", "vtt"] }] });
      if (typeof picked !== "string") return;
      applySubtitles(await backend.readFileBytes(picked), `disk:${picked}`, baseName(picked));
    } catch (error) {
      toast(describeError(error), "error");
    }
  };

  const disableSubtitles = () => {
    setCues([]);
    setSubtitleKey(null);
    setMenu(null);
  };

  // --- audio tracks and playback rate ------------------------------------------------------------

  const selectAudio = (index: number) => {
    const video = videoRef.current;
    const tracks = video?.audioTracks;
    if (!video || !tracks) return;
    for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === index;
    // Re-seeking to the same spot makes the decoder pick up the new track at once.
    video.currentTime = video.currentTime;
    setAudio((value) => ({ ...value, selected: index }));
    setMenu(null);
  };

  const selectRate = (value: number) => {
    if (videoRef.current) videoRef.current.playbackRate = value;
    setRate(value);
    setMenu(null);
  };

  // A file whose audio codec is unsupported plays silently; notice it and offer the external player.
  useEffect(() => {
    if (!playing || muted) return;
    const timer = setTimeout(() => {
      const video = videoRef.current;
      if (video && video.currentTime > 2 && video.webkitAudioDecodedByteCount === 0) setSilentAudio(true);
    }, silentAudioCheckDelayMs);
    return () => clearTimeout(timer);
  }, [playing, muted, url]);

  // --- end of episode ----------------------------------------------------------------------------

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      playNext();
      return;
    }
    const timer = setTimeout(() => setCountdown((value) => (value === null ? null : value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [countdown, playNext]);

  const onEnded = () => {
    saveProgress();
    setEnded(true);
    if (nextEpisode && settings.autoNextEpisode) setCountdown(nextEpisodeCountdownSeconds);
  };

  const openExternally = async () => {
    if (!source) return;
    try {
      videoRef.current?.pause();
      const name = await backend.openExternal(source.infoHash, source.fileIndex);
      toast(`Открыто в ${name}`, "success");
    } catch (error) {
      toast(describeError(error), "error");
    }
  };

  // --- render ------------------------------------------------------------------------------------

  if (!source) {
    return (
      <div className="player">
        <div className="player__center">
          <TriangleAlert size={40} />
          <strong>Для этого видео нет источника</strong>
          <button className="button button--primary" onClick={closePlayer}>
            Назад
          </button>
        </div>
      </div>
    );
  }

  const downloaded = fileProgress(torrent, source.fileIndex);
  // The light stretch shows how far ahead playback is safe; a finished file needs no such hint.
  const bufferedAhead = downloaded >= 1 ? [] : buffered.filter((range) => range.start <= current + 1 && range.end > current);
  const subtitle = session.episode !== undefined ? `Сезон ${session.season} · Серия ${session.episode}${session.episodeName ? ` — ${session.episodeName}` : ""}` : session.title.year;
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div
      ref={rootRef}
      className={`player ${controlsShown ? "" : "is-idle"}`}
      onMouseMove={wakeControls}
      onMouseDown={wakeControls}
    >
      {url && (
        <video
          ref={videoRef}
          key={url}
          src={url}
          autoPlay
          onClick={togglePlay}
          onDoubleClick={toggleFullscreen}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false);
            saveProgress();
          }}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => {
            setBuffering(false);
            setEnded(false);
          }}
          onCanPlay={() => setBuffering(false)}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget as VideoWithExtras;
            setDuration(video.duration);
            video.playbackRate = rate;
            if (resumeAt.current > 0 && resumeAt.current < video.duration - 5) video.currentTime = resumeAt.current;
            resumeAt.current = 0;
            setAudio(readAudioOptions(video));
            setResolution(video.videoWidth > 0 ? `${video.videoWidth}×${video.videoHeight}` : "");
            // A release name does not always state the quality; the decoded picture does.
            const detected = qualityFromSize(video.videoWidth, video.videoHeight);
            if (detected && !source.quality) useLibrary.getState().setSourceQuality(session.unitKey, source.id, detected);
          }}
          onDurationChange={(event) => setDuration(event.currentTarget.duration)}
          onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
          onProgress={(event) => {
            const ranges = event.currentTarget.buffered;
            setBuffered(Array.from({ length: ranges.length }, (_, index) => ({ start: ranges.start(index), end: ranges.end(index) })));
          }}
          onEnded={onEnded}
          onError={() => {
            setFailed(true);
            setBuffering(false);
          }}
        />
      )}

      {subtitleText && (
        <div className="player__subtitle" style={{ fontSize: `${settings.subtitleScale}em` }}>
          <span>{subtitleText}</span>
        </div>
      )}

      <div className="player__top" data-tauri-drag-region>
        <button className="player__back" aria-label="Назад" onClick={close}>
          <ArrowLeft size={22} />
        </button>
        <div className="player__title" data-tauri-drag-region>
          <strong>{session.title.title}</strong>
          <span>{subtitle}</span>
        </div>
        {torrent && downloaded < 1 && (
          <div className="player__stats">
            <span>{Math.floor(downloaded * 100)}%</span>
            <span>↓ {formatSpeed(torrent.downloadSpeed)}</span>
            <span>
              <Users size={12} /> {torrent.peers}
            </span>
          </div>
        )}
        {!fullscreen && <WindowButtons />}
      </div>

      <div className="player__center">
        {failed ? (
          <div className="player__message">
            <TriangleAlert size={36} />
            <strong>Встроенный плеер не может воспроизвести этот файл</strong>
            <p>Скорее всего, в нём редкий формат видео или звука. {externalPlayer ? "Его можно открыть во внешнем плеере." : "Установите VLC или mpv, чтобы открывать такие файлы."}</p>
            <div className="player__message-actions">
              {externalPlayer && (
                <button className="button button--primary" onClick={() => void openExternally()}>
                  <ExternalLink size={16} />
                  Открыть в {externalPlayer}
                </button>
              )}
              {sources.length > 1 && (
                <button className="button" onClick={() => setMenu("quality")}>
                  Другое качество
                </button>
              )}
            </div>
          </div>
        ) : countdown !== null && nextEpisode ? (
          <div className="player__message">
            <strong>Следующая серия через {countdown}</strong>
            <p>
              {nextEpisode.episode}. {nextEpisode.name}
            </p>
            <div className="player__message-actions">
              <button className="button button--primary" onClick={playNext}>
                <SkipForward size={16} />
                Смотреть сейчас
              </button>
              <button className="button" onClick={() => setCountdown(null)}>
                Отмена
              </button>
            </div>
          </div>
        ) : ended ? (
          <div className="player__message">
            <strong>Просмотр завершён</strong>
            <div className="player__message-actions">
              <button className="button" onClick={() => seekTo(0)}>
                <RotateCcw size={16} />
                Сначала
              </button>
              <button className="button button--primary" onClick={close}>
                Закрыть
              </button>
            </div>
          </div>
        ) : buffering ? (
          <div className="player__buffering">
            <LoaderCircle size={46} className="spin" />
            {torrent && downloaded < 1 && (
              <span>
                {torrent.peers > 0 ? `Загружаем · ${formatSpeed(torrent.downloadSpeed)} · участников: ${torrent.peers}` : "Ищем участников раздачи…"}
              </span>
            )}
          </div>
        ) : null}
      </div>

      {silentAudio && !failed && (
        <div className="player__notice">
          <TriangleAlert size={16} />
          <span>Звук в этом файле в формате, который встроенный плеер не поддерживает.</span>
          {externalPlayer && (
            <button className="button button--small" onClick={() => void openExternally()}>
              Открыть в {externalPlayer}
            </button>
          )}
          <button className="button button--small" onClick={() => setSilentAudio(false)}>
            Скрыть
          </button>
        </div>
      )}

      <div className="player__bottom">
        <SeekBar current={current} duration={duration} buffered={bufferedAhead} onSeek={seekTo} />
        <div className="player__controls">
          <button className="player__button player__button--main" aria-label={playing ? "Пауза" : "Смотреть"} onClick={togglePlay}>
            {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
          </button>
          <button className="player__button" aria-label="Назад на 10 секунд" onClick={() => seekBy(-seekStepSeconds)}>
            <RotateCcw size={19} />
          </button>
          <button className="player__button" aria-label="Вперёд на 10 секунд" onClick={() => seekBy(seekStepSeconds)}>
            <RotateCw size={19} />
          </button>
          {nextEpisode && (
            <button className="player__button" aria-label="Следующая серия" title={`Следующая: ${nextEpisode.name}`} onClick={playNext}>
              <SkipForward size={19} />
            </button>
          )}
          <div className="player__volume">
            <button className="player__button" aria-label="Звук" onClick={() => setMuted((value) => !value)}>
              <VolumeIcon size={19} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              aria-label="Громкость"
              style={{ "--fill": `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
              onChange={(event) => {
                setMuted(false);
                setVolume(Number(event.target.value));
              }}
            />
          </div>
          <div className="player__time">
            {formatClock(current)} <span>/ {formatClock(duration)}</span>
          </div>

          <div className="player__spacer" />

          <button className={`player__button ${cues.length > 0 ? "is-on" : ""}`} aria-label="Субтитры" onClick={() => setMenu(menu === "subtitles" ? null : "subtitles")}>
            <Captions size={20} />
          </button>
          {audio.options.length > 0 && (
            <button className="player__button" aria-label="Звуковая дорожка" onClick={() => setMenu(menu === "audio" ? null : "audio")}>
              <AudioLines size={19} />
            </button>
          )}
          <button className="player__button" aria-label="Скорость" onClick={() => setMenu(menu === "speed" ? null : "speed")}>
            <Gauge size={19} />
            {rate !== 1 && <small>{rate}×</small>}
          </button>
          <button className="player__button player__button--quality" aria-label="Качество" onClick={() => setMenu(menu === "quality" ? null : "quality")}>
            <Settings2 size={19} />
            <small>{source.quality || "видео"}</small>
          </button>
          <button className="player__button" aria-label={fullscreen ? "Выйти из полноэкранного режима" : "На весь экран"} onClick={toggleFullscreen}>
            {fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}
          </button>
        </div>

        {menu === "quality" && (
          <div className="player__menu">
            <h3>Качество</h3>
            {sources.map((item) => (
              <QualityOption
                key={item.id}
                source={item}
                active={item.id === source.id}
                resolution={item.id === source.id ? resolution : ""}
                onPick={() => switchSource(item)}
              />
            ))}
            {externalPlayer && (
              <button className="player__menu-item" onClick={() => void openExternally()}>
                <ExternalLink size={15} />
                <span>Открыть в {externalPlayer}</span>
              </button>
            )}
          </div>
        )}
        {menu === "audio" && (
          <div className="player__menu">
            <h3>Звуковая дорожка</h3>
            {audio.options.map((option) => (
              <button key={option.index} className="player__menu-item" onClick={() => selectAudio(option.index)}>
                {option.index === audio.selected ? <Check size={15} /> : <i />}
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        )}
        {menu === "speed" && (
          <div className="player__menu">
            <h3>Скорость</h3>
            {playbackRates.map((value) => (
              <button key={value} className="player__menu-item" onClick={() => selectRate(value)}>
                {value === rate ? <Check size={15} /> : <i />}
                <span>{value === 1 ? "Обычная" : `${value}×`}</span>
              </button>
            ))}
          </div>
        )}
        {menu === "subtitles" && (
          <div className="player__menu">
            <h3>Субтитры</h3>
            <button className="player__menu-item" onClick={disableSubtitles}>
              {cues.length === 0 ? <Check size={15} /> : <i />}
              <span>Выключены</span>
            </button>
            {subtitleOptions.map((option) => (
              <button
                key={option.key}
                className="player__menu-item"
                title={baseName(option.file.path)}
                onClick={() => void loadTorrentSubtitle(option)}
              >
                {subtitleKey === option.key ? <Check size={15} /> : <i />}
                <span>{option.label}</span>
                <small>{option.detail}</small>
              </button>
            ))}
            {subtitleKey?.startsWith("disk:") && (
              <button className="player__menu-item">
                <Check size={15} />
                <span>{subtitleLabel}</span>
              </button>
            )}
            <button className="player__menu-item" onClick={() => void loadSubtitleFromDisk()}>
              <i />
              <span>Загрузить из файла…</span>
            </button>
            <h3>Размер</h3>
            <div className="player__menu-row">
              {subtitleScales.map((scale) => (
                <button
                  key={scale.value}
                  className={`chip ${settings.subtitleScale === scale.value ? "is-active" : ""}`}
                  onClick={() => settings.patch({ subtitleScale: scale.value })}
                >
                  {scale.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function QualityOption({
  source,
  active,
  resolution,
  onPick,
}: {
  source: Source;
  active: boolean;
  resolution: string;
  onPick: () => void;
}) {
  const progress = useTorrents((state) => fileProgress(state.byHash[source.infoHash], source.fileIndex));
  return (
    <button className="player__menu-item" onClick={onPick}>
      {active ? <Check size={15} /> : <i />}
      <span>
        {source.quality || "видео"}
        {source.tags.length > 0 && <em> {source.tags.join(" · ")}</em>}
      </span>
      <small>
        {resolution && `${resolution} · `}
        {formatBytes(source.size)} · {progress >= 1 ? "скачано" : `${Math.floor(progress * 100)}%`}
      </small>
    </button>
  );
}

export function Player() {
  const session = useUi((state) => state.player);
  if (!session) return null;
  return <PlayerView key={session.unitKey} session={session} />;
}
