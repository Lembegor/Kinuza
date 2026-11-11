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
  PictureInPicture2,
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
  X,
} from "lucide-react";
import {
  backend,
  convertedStreamUrl,
  describeError,
  getAppInfo,
  isDesktop,
  streamUrl,
  type AudioTrackInfo,
  type Chapter,
  type OnlineSubtitle,
  type SubtitleTrackInfo,
  type TorrentFile,
} from "../lib/backend";
import { t, useT, type MessageKey } from "../lib/i18n";
import { languageCode, languageName } from "../lib/languages";
import { beforeAppClose } from "../lib/lifecycle";
import { setMiniWindow } from "../lib/miniWindow";
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
import { isWatched, titleKey, unitKey, useLibrary, type Source } from "../state/library";
import { useSettings } from "../state/settings";
import { fileProgress, useTorrents } from "../state/torrents";
import { useUi, type PlayerSession } from "../state/ui";
import { WindowButtons } from "./Shell";
import { useConvertedAudio } from "./useConvertedAudio";
import { useEmbeddedSubtitles, useMediaTracks } from "./useMediaTracks";

const controlsHideDelayMs = 3000;
const progressSaveIntervalMs = 5000;
const seekStepSeconds = 10;
/** Shift with an arrow key jumps this far. */
const longSeekStepSeconds = 60;
const volumeStep = 0.05;
/** Presses of a seek key this close together add up on screen: "+10 s", "+20 s". */
const seekRunGapMs = 1000;
const hintLifetimeMs = 900;
/** How long after the player lets go of a torrent its online data is deleted, unless the next episode took it over. */
const releaseDelayMs = 1500;
/** Audio the built-in player decodes itself; anything else is converted on the fly. */
const builtInAudioCodecs = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const subtitlesOff = "off";
/**
 * Pictures the built-in player cannot decode, as FFmpeg names their codecs; such a film goes
 * straight to conversion instead of failing first.
 */
const convertedVideoCodecs = new Set(["mpeg4", "msmpeg4v2", "msmpeg4v3", "mpeg2video", "mpeg1video", "wmv1", "wmv2", "wmv3", "vc1", "rv30", "rv40", "flv1", "h263", "theora"]);

/** One press moves the subtitles or the sound by this much. */
const delayStepSeconds = 0.1;
const longestDelaySeconds = 10;
/** A chapter is offered for skipping until this close to its end. */
const skipOfferEndsSeconds = 2;

/** Chapters worth a "skip" button, by the names releases give them. */
const skippableChapters: { kind: "intro" | "credits" | "recap"; pattern: RegExp }[] = [
  { kind: "intro", pattern: /\b(intro|opening|op)\b|заставк|опенинг/i },
  { kind: "credits", pattern: /\b(credits|ending|ed|outro)\b|титр|эндинг/i },
  { kind: "recap", pattern: /\b(recap|previously)\b|ранее|в предыдущ/i },
];

function skipKind(chapter: Chapter): "intro" | "credits" | "recap" | null {
  return skippableChapters.find(({ pattern }) => pattern.test(chapter.title))?.kind ?? null;
}

/** The developer's OpenSubtitles key, baked into the build; without it the online search is not offered. */
const onlineSubtitlesKey: string = import.meta.env.VITE_OPENSUBTITLES_API_KEY ?? "";
/** Shared words between a release name and a file name from which the subtitles count as timed to this copy. */
const sameReleaseWords = 3;
const onlineSubtitleErrors = ["subtitles_key_invalid", "subtitles_quota", "subtitles_unavailable"] as const;

/** Words that tell releases apart: "1080p", "bluray", a group's name. Short ones are noise. */
function releaseWords(name: string): Set<string> {
  return new Set(name.toLowerCase().split(/[^a-z0-9а-яё]+/).filter((word) => word.length >= 3));
}

function sharedWords(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared;
}

function clampDelay(seconds: number): number {
  return Math.round(Math.min(longestDelaySeconds, Math.max(-longestDelaySeconds, seconds)) * 10) / 10;
}

function playsUnconverted(track: AudioTrackInfo): boolean {
  return builtInAudioCodecs.has(track.codec) || track.codec.startsWith("pcm_");
}
/** Positions before this are not worth resuming from. */
const minResumeSeconds = 15;
const nextEpisodeCountdownSeconds = 8;
const silentAudioCheckDelayMs = 5000;
const settingsSaveDelayMs = 400;
const maxTorrentSubtitles = 12;
const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2];
const subtitleScales: { label: MessageKey; value: number }[] = [
  { label: "player.subtitles.size.small", value: 0.8 },
  { label: "player.subtitles.size.normal", value: 1 },
  { label: "player.subtitles.size.large", value: 1.3 },
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
    options.push({ index, label: name || t("player.track", { number: index + 1 }) });
  }
  return { options, selected };
}

/** How an audio track is named in the menu: language, the release's own title, format. */
function audioTrackLabel(track: AudioTrackInfo, locale: string): string {
  const format = [track.codec.toUpperCase(), track.channels.replace(/\(.*\)/, "")].filter(Boolean).join(" ");
  const language = languageName(languageCode(track.language), locale);
  return [language, track.title, format].filter(Boolean).join(" · ") || t("player.track", { number: track.index + 1 });
}

/** "Forced" subtitles translate only signs and foreign lines; releases mark them by a flag or just in the name. */
function showsSignsOnly(track: SubtitleTrackInfo): boolean {
  return track.isForced || /forced|форсир|надпис/i.test(track.title);
}

function embeddedSubtitleLabel(track: SubtitleTrackInfo, locale: string): string {
  return languageName(languageCode(track.language), locale) || track.title || t("player.track", { number: track.index + 1 });
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
  chapters,
  onSeek,
}: {
  current: number;
  duration: number;
  buffered: { start: number; end: number }[];
  /** Chapters marked in the file; their borders are shown on the bar and their names while hovering. */
  chapters: Chapter[];
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
        {chapters.slice(1).map((chapter) => (
          <i key={chapter.start} className="seek__chapter" style={{ left: `${(chapter.start / safeDuration) * 100}%` }} />
        ))}
        <i className="seek__thumb" style={{ left: `${playedRatio * 100}%` }} />
      </div>
      {hover !== null && duration > 0 && (
        <span className="seek__tooltip" style={{ left: `${hover * 100}%` }}>
          {formatClock(hover * duration)}
          {(() => {
            const chapter = chapters.find((item) => hover * duration >= item.start && hover * duration < item.end);
            return chapter?.title ? <small>{chapter.title}</small> : null;
          })()}
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
  const { t, language, locale } = useT();

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
  const [rate, setRate] = useState(() => useLibrary.getState().preferences[titleKey(session.title.type, session.title.id)]?.rate ?? 1);
  const [audio, setAudio] = useState<{ options: AudioOption[]; selected: number }>({ options: [], selected: 0 });
  const [cues, setCues] = useState<Cue[]>([]);
  const [subtitleKey, setSubtitleKey] = useState<string | null>(null);
  const [subtitleLabel, setSubtitleLabel] = useState("");
  const [resolution, setResolution] = useState("");
  const [subtitleText, setSubtitleText] = useState("");
  const [volume, setVolume] = useState(settings.volume);
  const [muted, setMuted] = useState(settings.muted);
  const externalPlayer = useAsync(getAppInfo, []).data?.externalPlayer ?? null;

  // Tracks of the file as FFmpeg sees them; the player's own list has only what it can decode.
  const media = useMediaTracks(source ?? null);
  const originalLanguage = useAsync(() => tmdb.details(session.title.type, session.title.id), [session.title.type, session.title.id]).data?.language ?? "";
  /** The audio track in use, as a position in `media.tracks.audio`; null until one has been chosen. */
  const [audioTrack, setAudioTrack] = useState<number | null>(null);
  /** The same position when that track has to be converted to be heard; null when the player decodes it itself. */
  const [convertedTrack, setConvertedTrack] = useState<number | null>(null);
  const [embeddedSubtitle, setEmbeddedSubtitle] = useState<number | null>(null);
  const [metadataReady, setMetadataReady] = useState(false);
  // How this title is watched is remembered for it alone: one series does not change another.
  const preferencesKey = titleKey(session.title.type, session.title.id);
  const preferences = useLibrary((state) => state.preferences[preferencesKey]);
  const rememberForTitle = useLibrary((state) => state.setTitlePreferences);
  const [subtitleDelay, setSubtitleDelay] = useState(preferences?.subtitleDelay ?? 0);
  const [audioDelay, setAudioDelay] = useState(preferences?.audioDelay ?? 0);
  const chapters = media.tracks?.chapters ?? [];

  // A film the player cannot decode is played through conversion: the video element then gets a
  // stream that begins at `conversionStart`, and its own clock counts from there. Everything that
  // deals in film time (the bar, progress, subtitles, seeking) goes through `filmTime`/`filmLength`.
  const [conversionStart, setConversionStart] = useState<number | null>(null);
  const conversionRef = useRef<number | null>(null);
  conversionRef.current = conversionStart;
  const statedLength = useRef(0);
  statedLength.current = media.tracks?.duration ?? 0;
  const filmTime = useCallback(() => (conversionRef.current ?? 0) + (videoRef.current?.currentTime ?? 0), []);
  const filmLength = useCallback(
    () => (conversionRef.current !== null ? statedLength.current : (videoRef.current?.duration ?? 0)),
    [],
  );
  // The player cannot shift its own sound in time, so a delayed track goes through conversion too.
  // A converted film carries its sound inside the stream.
  const heardConverted = conversionStart !== null ? null : (convertedTrack ?? (audioDelay !== 0 ? audioTrack : null));
  // A chapter the release marks as the intro, the recap or the credits can be skipped. Only what
  // the file itself marks is offered: there is no guessing where an intro might be.
  const skippable = chapters.find((chapter) => current >= chapter.start && current < chapter.end - skipOfferEndsSeconds && skipKind(chapter) !== null);
  /** The user picked a track for this file by hand, so defaults must not override it. */
  const pickedAudio = useRef(false);
  const subtitlesDecided = useRef(false);
  const [hint, setHint] = useState<{ text: string; id: number } | null>(null);
  /** The panel with subtitles found on the internet is open. */
  const [onlinePanel, setOnlinePanel] = useState(false);
  /** Language whose results the panel shows; empty until the first results choose one. */
  const [onlineLanguage, setOnlineLanguage] = useState("");

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
    setMetadataReady(false);
    setConversionStart(null);
    setAudioTrack(null);
    setConvertedTrack(null);
    setEmbeddedSubtitle(null);
    pickedAudio.current = false;
    subtitlesDecided.current = false;
    void streamUrl(source.infoHash, source.fileIndex).then((value) => {
      if (!cancelled) setUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [source?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (conversionStart === null || !source) return;
    let cancelled = false;
    void convertedStreamUrl(source.infoHash, source.fileIndex, audioTrack ?? 0, conversionStart).then((value) => {
      if (!cancelled) setUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [conversionStart, audioTrack, source?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Plays the film through conversion from where it is (or was meant to resume). */
  const startConversion = useCallback(() => {
    setFailed(false);
    setBuffering(true);
    setConversionStart(resumeAt.current > 0 ? resumeAt.current : filmTime());
  }, [filmTime]);

  // A picture known not to decode goes to conversion at once; so does a film that failed while
  // FFmpeg was still being downloaded.
  const unplayablePicture = convertedVideoCodecs.has(media.tracks?.videoCodec ?? "");
  useEffect(() => {
    if (conversionStart === null && media.tracks && (unplayablePicture || failed)) startConversion();
  }, [media.tracks, unplayablePicture, failed]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveProgress = useCallback(() => {
    const video = videoRef.current;
    const length = filmLength();
    if (!video || !Number.isFinite(length) || length <= 0 || filmTime() < 1) return;
    useLibrary.getState().setProgress(session.unitKey, {
      position: filmTime(),
      duration: length,
      updatedAt: Date.now(),
      title: session.title,
      season: session.season,
      episode: session.episode,
      episodeName: session.episodeName,
    });
  }, [session, filmTime, filmLength]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(saveProgress, progressSaveIntervalMs);
    return () => clearInterval(timer);
  }, [playing, saveProgress]);

  // Closing the app mid-film must not lose the position reached since the last periodic save.
  useEffect(() => beforeAppClose(saveProgress), [saveProgress]);

  // What an online viewing fetched is deleted once the player lets go of the torrent: on closing
  // the player, on switching to another copy, on closing the app. Going on to the next episode of
  // the same torrent keeps it, so that is checked after the next player has had time to open.
  const playedTorrent = source?.infoHash;
  useEffect(() => {
    if (!playedTorrent) return;
    const stopOnExit = beforeAppClose(() => backend.releaseOnline(playedTorrent));
    return () => {
      stopOnExit();
      setTimeout(() => {
        const next = useUi.getState().player;
        const stillPlayed = next !== null && (useLibrary.getState().sources[next.unitKey] ?? []).some((item) => item.infoHash === playedTorrent);
        if (!stillPlayed) void backend.releaseOnline(playedTorrent).then(() => useTorrents.getState().refresh());
      }, releaseDelayMs);
    };
  }, [playedTorrent]);

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
    const length = filmLength();
    if (!video || !Number.isFinite(length) || length <= 0) return;
    const target = Math.min(Math.max(0, time), Math.max(0, length - 0.5));
    if (conversionRef.current !== null) {
      // A converted stream cannot be sought: a new one is asked for from the new spot.
      setConversionStart(target);
      setBuffering(true);
    } else {
      video.currentTime = target;
    }
    setCurrent(target);
    setEnded(false);
    setCountdown(null);
  }, []);

  const showHint = useCallback((text: string) => setHint({ text, id: Date.now() }), []);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), hintLifetimeMs);
    return () => clearTimeout(timer);
  }, [hint]);

  /** Seconds sought by the current run of key presses, and when the last press was. */
  const seekRun = useRef({ total: 0, at: 0 });
  const seekBy = useCallback(
    (delta: number) => {
      seekTo(filmTime() + delta);
      const now = performance.now();
      const run = seekRun.current;
      const continues = now - run.at < seekRunGapMs && Math.sign(run.total) === Math.sign(delta);
      run.total = continues ? run.total + delta : delta;
      run.at = now;
      const seconds = Math.abs(run.total);
      const minutes = Math.floor(seconds / 60);
      const amount =
        seconds < 60
          ? t("common.duration.seconds", { seconds })
          : seconds % 60
            ? t("common.duration.minutesSeconds", { minutes, seconds: seconds % 60 })
            : t("common.duration.minutes", { minutes });
      showHint(`${run.total > 0 ? "+" : "−"}${amount}`);
    },
    [seekTo, showHint],
  );

  const switchSource = (next: Source) => {
    if (next.id === source?.id) return;
    resumeAt.current = filmTime();
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

  // The mini player: the whole window becomes a small frame that stays on top of other windows.
  const [mini, setMini] = useState(false);
  const toggleMini = useCallback(() => {
    setMini((value) => {
      if (!value) {
        // A fullscreen window cannot be shrunk.
        setFullscreen(false);
        void setWindowFullscreen(false, rootRef.current).then(() => setMiniWindow(true));
      } else {
        void setMiniWindow(false);
      }
      return !value;
    });
  }, []);
  // Leaving the player in any way gives the window back its size.
  useEffect(() => () => void setMiniWindow(false), []);

  // --- volume ------------------------------------------------------------------------------------

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.volume = volume;
      // While a converted track plays, the film's own sound stays off: two tracks at once would overlap.
      video.muted = muted || heardConverted !== null;
    }
    const timer = setTimeout(() => useSettings.getState().patch({ volume, muted }), settingsSaveDelayMs);
    return () => clearTimeout(timer);
  }, [volume, muted, url, heardConverted]);

  const changeVolume = useCallback(
    (delta: number) => {
      setMuted(false);
      setVolume((value) => {
        const next = Math.min(1, Math.max(0, Math.round((value + delta) * 100) / 100));
        showHint(t("player.hint.volume", { percent: Math.round(next * 100) }));
        return next;
      });
    },
    [showHint],
  );

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
      const video = videoRef.current;
      const stepRate = (direction: 1 | -1) => {
        const index = playbackRates.indexOf(rate) + direction;
        const next = playbackRates[Math.min(playbackRates.length - 1, Math.max(0, index))];
        if (video) video.playbackRate = next;
        setRate(next);
        rememberForTitle(session.title, { rate: next });
        showHint(t("player.hint.speed", { rate: next }));
      };
      const handlers: Record<string, () => void> = {
        " ": togglePlay,
        k: togglePlay,
        ArrowLeft: () => seekBy(event.shiftKey ? -longSeekStepSeconds : -seekStepSeconds),
        ArrowRight: () => seekBy(event.shiftKey ? longSeekStepSeconds : seekStepSeconds),
        j: () => seekBy(-seekStepSeconds),
        l: () => seekBy(seekStepSeconds),
        ArrowUp: () => changeVolume(volumeStep),
        ArrowDown: () => changeVolume(-volumeStep),
        Home: () => seekTo(0),
        End: () => seekTo(filmLength()),
        f: toggleFullscreen,
        i: toggleMini,
        m: () => setMuted((value) => !value),
        n: playNext,
        c: () => setMenu((value) => (value === "subtitles" ? null : "subtitles")),
        a: () => setMenu((value) => (value === "audio" ? null : "audio")),
        "[": () => stepRate(-1),
        "]": () => stepRate(1),
        g: () => shiftSubtitles(-delayStepSeconds),
        h: () => shiftSubtitles(delayStepSeconds),
        s: () => {
          if (skippable) seekTo(skippable.end);
        },
        Escape: () => {
          if (onlinePanel) setOnlinePanel(false);
          else if (menu) setMenu(null);
          else if (fullscreen) toggleFullscreen();
          else close();
        },
      };
      // The digit keys jump to tenths of the film: 0 is the start, 5 the middle.
      if (/^[0-9]$/.test(event.key) && video && Number.isFinite(filmLength())) {
        event.preventDefault();
        seekTo((filmLength() * Number(event.key)) / 10);
        showHint(`${Number(event.key) * 10}%`);
        wakeControls();
        return;
      }
      // Russian layout: the same physical keys type other letters.
      const sameKeys: Record<string, string> = { "а": "f", "ь": "m", "л": "k", "о": "j", "д": "l", "т": "n", "с": "c", "ф": "a", "х": "[", "ъ": "]", "п": "g", "р": "h", "ы": "s", "ш": "i" };
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const handler = handlers[event.key] ?? handlers[key] ?? handlers[sameKeys[key] ?? ""];
      if (!handler) return;
      event.preventDefault();
      handler();
      wakeControls();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekBy, seekTo, changeVolume, toggleFullscreen, playNext, close, menu, fullscreen, wakeControls, rate, showHint, subtitleDelay, skippable, toggleMini, onlinePanel]);

  // --- subtitles ---------------------------------------------------------------------------------

  useEffect(() => {
    if (cues.length === 0) {
      setSubtitleText("");
      return;
    }
    let frame = 0;
    const update = () => {
      const text = activeCueText(cues, filmTime() - subtitleDelay);
      setSubtitleText((previous) => (previous === text ? previous : text));
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [cues, subtitleDelay]);

  const embeddedCues = useEmbeddedSubtitles(() => ({ time: filmTime(), duration: filmLength() }), source ?? null, embeddedSubtitle);
  useEffect(() => {
    if (embeddedSubtitle !== null) setCues(embeddedCues);
  }, [embeddedCues, embeddedSubtitle]);

  /** A choice made by hand is remembered for this title; one made for the user is not. */
  const rememberSubtitles = (language: string | null, byUser: boolean) => {
    subtitlesDecided.current = true;
    if (byUser && language) rememberForTitle(session.title, { subtitleLanguage: language });
  };

  const shiftSubtitles = (step: number) => {
    const next = step === 0 ? 0 : clampDelay(subtitleDelay + step);
    setSubtitleDelay(next);
    rememberForTitle(session.title, { subtitleDelay: next });
    showHint(t("player.delay.subtitles.hint", { value: formatDelay(next) }));
  };

  const shiftAudio = (step: number) => {
    const next = step === 0 ? 0 : clampDelay(audioDelay + step);
    setAudioDelay(next);
    rememberForTitle(session.title, { audioDelay: next });
    showHint(t("player.delay.audio.hint", { value: formatDelay(next) }));
  };

  /** "+0,3 с": a delay with its sign, in the interface language's number format. */
  const formatDelay = (seconds: number) =>
    t("player.delay.value", { seconds: `${seconds > 0 ? "+" : seconds < 0 ? "−" : ""}${Math.abs(seconds).toLocaleString(locale, { minimumFractionDigits: 1 })}` });

  const selectEmbeddedSubtitle = (track: SubtitleTrackInfo, byUser: boolean) => {
    setCues([]);
    setEmbeddedSubtitle(track.index);
    setSubtitleKey(`embedded:${track.index}`);
    setSubtitleLabel(embeddedSubtitleLabel(track, locale));
    setMenu(null);
    rememberSubtitles(languageCode(track.language), byUser);
  };

  const applySubtitles = (bytes: ArrayBuffer, key: string, label: string) => {
    const parsed = parseSubtitles(decodeSubtitleBytes(bytes));
    if (parsed.length === 0) {
      toast(t("player.subtitles.noneInFile"), "error");
      return;
    }
    setEmbeddedSubtitle(null);
    setCues(parsed);
    setSubtitleKey(key);
    setSubtitleLabel(label);
    setMenu(null);
  };

  const loadTorrentSubtitle = async (option: SubtitleOption, byUser = true) => {
    if (!source) return;
    try {
      const response = await fetch(await streamUrl(source.infoHash, option.file.index));
      if (!response.ok) throw new Error("file_unreadable");
      applySubtitles(await response.arrayBuffer(), option.key, option.label);
      rememberSubtitles(option.languageCode, byUser);
    } catch (error) {
      toast(describeError(error), "error");
    }
  };

  const loadSubtitleFromDisk = async () => {
    if (!isDesktop) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ title: t("player.subtitles.fileDialog"), filters: [{ name: t("common.subtitles"), extensions: ["srt", "ass", "ssa", "vtt"] }] });
      if (typeof picked !== "string") return;
      applySubtitles(await backend.readFileBytes(picked), `disk:${picked}`, baseName(picked));
    } catch (error) {
      toast(describeError(error), "error");
    }
  };

  // --- subtitles from the internet ---
  const [online, setOnline] = useState<{ loading: boolean; items: (OnlineSubtitle & { sameRelease: boolean })[] | null; error: string }>({
    loading: false,
    items: null,
    error: "",
  });
  const onlineError = (error: unknown) => {
    const code = onlineSubtitleErrors.find((known) => known === error);
    return code ? t(`errors.${code}`) : describeError(error);
  };

  const findOnlineSubtitles = async () => {
    if (!source) return;
    setMenu(null);
    setOnlinePanel(true);
    setOnline({ loading: true, items: null, error: "" });
    try {
      const wanted = [preferences?.subtitleLanguage, settings.subtitleLanguage, language, "en"].filter(
        (code): code is string => Boolean(code) && code !== subtitlesOff,
      );
      const languages = [...new Set(wanted)];
      const found = await backend.findOnlineSubtitles(onlineSubtitlesKey, {
        tmdbId: session.title.id,
        season: session.season ?? null,
        episode: session.episode ?? null,
        languages,
      });
      // Subtitles timed to this very release need no adjusting, so they come first; then the
      // language the user wants most, then what most people chose.
      const playing = releaseWords(`${source.torrentName} ${source.fileName}`);
      const items = found
        .map((item) => ({ ...item, shared: sharedWords(releaseWords(item.release), playing) }))
        .sort(
          (a, b) =>
            Number(b.shared >= sameReleaseWords) - Number(a.shared >= sameReleaseWords) ||
            languages.indexOf(a.language) - languages.indexOf(b.language) ||
            b.shared - a.shared ||
            b.downloads - a.downloads,
        )
        .map(({ shared, ...item }) => ({ ...item, sameRelease: shared >= sameReleaseWords }));
      setOnline({ loading: false, items, error: "" });
      // The most wanted language that actually has subtitles is shown first.
      setOnlineLanguage(languages.find((code) => items.some((item) => item.language === code)) ?? items[0]?.language ?? "");
    } catch (error) {
      setOnline({ loading: false, items: null, error: onlineError(error) });
    }
  };

  const loadOnlineSubtitle = async (item: OnlineSubtitle) => {
    try {
      const bytes = await backend.downloadOnlineSubtitle(onlineSubtitlesKey, item.fileId);
      applySubtitles(bytes, `online:${item.fileId}`, languageName(item.language, locale) || item.release);
      rememberSubtitles(item.language, true);
      setOnlinePanel(false);
    } catch (error) {
      toast(onlineError(error), "error");
    }
  };

  const disableSubtitles = () => {
    setEmbeddedSubtitle(null);
    setCues([]);
    setSubtitleKey(null);
    setMenu(null);
    rememberSubtitles(subtitlesOff, true);
  };

  // --- audio tracks and playback rate ------------------------------------------------------------

  /** Switches between the tracks the player decodes itself (its own list, when FFmpeg is not there to give a fuller one). */
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

  /** Makes `index` (a position in `media.tracks.audio`) the track that is heard. */
  const applyAudioTrack = useCallback(
    (index: number) => {
      const tracks = media.tracks?.audio;
      const video = videoRef.current;
      const track = tracks?.[index];
      if (!tracks || !video || !track) return;
      if (conversionRef.current !== null) {
        setAudioTrack(index);
        setConversionStart(filmTime());
        return;
      }

      // The player lists only the tracks it can decode, in file order; a different count means the lists cannot be matched.
      const builtIn = tracks.filter(playsUnconverted);
      const own = video.audioTracks;
      const position = builtIn.indexOf(track);
      const listsMatch = own !== undefined && own.length === builtIn.length;
      if (position >= 0 && listsMatch) {
        for (let i = 0; i < own.length; i++) own[i].enabled = i === position;
        video.currentTime = video.currentTime;
        setConvertedTrack(null);
      } else if (position === 0 && !listsMatch) {
        // No way to switch, but this is the track the player starts with anyway.
        setConvertedTrack(null);
      } else {
        setConvertedTrack(index);
      }
      setAudioTrack(index);
    },
    [media.tracks],
  );

  // Default sound: the language the user picked last, else the film's original language.
  useEffect(() => {
    const tracks = media.tracks?.audio;
    if (!tracks || tracks.length === 0 || !metadataReady || pickedAudio.current) return;
    const wanted = preferences?.audioLanguage || settings.audioLanguage || originalLanguage;
    const inLanguage = tracks.filter((track) => languageCode(track.language) === wanted);
    const choice =
      // The same studio as last time, when this title has a remembered one.
      inLanguage.find((track) => preferences?.audioTitle && track.title === preferences.audioTitle) ??
      inLanguage.find(playsUnconverted) ??
      inLanguage[0] ??
      (preferences?.audioLanguage || settings.audioLanguage ? undefined : tracks.find((track) => track.isOriginal)) ??
      tracks.find((track) => track.isDefault) ??
      tracks[0];
    if (choice.index !== audioTrack) applyAudioTrack(choice.index);
  }, [media.tracks, metadataReady, originalLanguage, applyAudioTrack]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseAudioTrack = (track: AudioTrackInfo) => {
    pickedAudio.current = true;
    applyAudioTrack(track.index);
    setMenu(null);
    const chosen = languageCode(track.language);
    if (chosen) rememberForTitle(session.title, { audioLanguage: chosen, audioTitle: track.title });
  };

  useConvertedAudio(videoRef, source ?? null, heardConverted, volume, muted, audioDelay);

  // Default subtitles: the language the user picked last, else the interface language, unless
  // the sound is already in that language and the user never asked for subtitles.
  useEffect(() => {
    if (!metadataReady || subtitlesDecided.current) return;
    // With FFmpeg present, wait for the file's own tracks and for the sound to be settled.
    if (media.ffmpegInstalled === null || (media.ffmpegInstalled && media.tracks === null)) return;
    if (media.tracks && media.tracks.audio.length > 0 && audioTrack === null) return;
    subtitlesDecided.current = true;

    const asked = preferences?.subtitleLanguage || settings.subtitleLanguage;
    const wanted = asked || language;
    if (wanted === subtitlesOff) return;
    const heard = audioTrack !== null ? languageCode(media.tracks?.audio[audioTrack]?.language) : "";
    if (!asked && heard === wanted) return;

    const embedded = (media.tracks?.subtitles ?? []).filter((track) => track.isText && languageCode(track.language) === wanted);
    const full = embedded.find((track) => !showsSignsOnly(track)) ?? embedded[0];
    const file = subtitleOptions.find((option) => option.languageCode === wanted);
    if (full) selectEmbeddedSubtitle(full, false);
    else if (file) void loadTorrentSubtitle(file, false);
  }, [metadataReady, media.tracks, media.ffmpegInstalled, audioTrack, subtitleOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectRate = (value: number) => {
    if (videoRef.current) videoRef.current.playbackRate = value;
    setRate(value);
    rememberForTitle(session.title, { rate: value });
    setMenu(null);
  };

  // A file whose audio codec is unsupported plays silently; notice it and switch to converted sound.
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
      toast(t("player.openedIn", { player: name }), "success");
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
          <strong>{t("player.noSource")}</strong>
          <button className="button button--primary" onClick={closePlayer}>
            {t("common.back")}
          </button>
        </div>
      </div>
    );
  }

  const downloaded = fileProgress(torrent, source.fileIndex);
  // The light stretch shows how far ahead playback is safe; a finished file needs no such hint.
  const bufferedAhead = downloaded >= 1 ? [] : buffered.filter((range) => range.start <= current + 1 && range.end > current);
  const subtitle =
    session.episode !== undefined
      ? `${t("common.seasonEpisode", { season: session.season ?? "", episode: session.episode })}${session.episodeName ? ` — ${session.episodeName}` : ""}`
      : session.title.year;
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div
      ref={rootRef}
      className={`player ${controlsShown ? "" : "is-idle"} ${mini ? "is-mini" : ""}`}
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
            video.playbackRate = rate;
            if (conversionRef.current !== null) {
              // The stream already begins where playback should; its own length says nothing about the film's.
              setDuration(statedLength.current);
            } else {
              setDuration(video.duration);
              if (resumeAt.current > 0 && resumeAt.current < video.duration - 5) video.currentTime = resumeAt.current;
            }
            resumeAt.current = 0;
            setAudio(readAudioOptions(video));
            setMetadataReady(true);
            setResolution(video.videoWidth > 0 ? `${video.videoWidth}×${video.videoHeight}` : "");
            // A release name does not always state the quality; the decoded picture does.
            const detected = qualityFromSize(video.videoWidth, video.videoHeight);
            if (detected && !source.quality) useLibrary.getState().setSourceQuality(session.unitKey, source.id, detected);
          }}
          onDurationChange={(event) => {
            if (conversionRef.current === null) setDuration(event.currentTarget.duration);
          }}
          onTimeUpdate={() => setCurrent(filmTime())}
          onProgress={(event) => {
            const ranges = event.currentTarget.buffered;
            const offset = conversionRef.current ?? 0;
            setBuffered(
              Array.from({ length: ranges.length }, (_, index) => ({ start: offset + ranges.start(index), end: offset + ranges.end(index) })),
            );
          }}
          onSeeked={saveProgress}
          onEnded={onEnded}
          onError={() => {
            // With FFmpeg at hand, a film the player cannot decode is converted instead of given up on.
            if (conversionRef.current === null && media.tracks) {
              startConversion();
              return;
            }
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
        <button className="player__back" aria-label={t("common.back")} onClick={close}>
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
            <strong>{t("player.failed.title")}</strong>
            <p>{t("player.failed.reason")} {externalPlayer ? t("player.failed.openExternal") : t("player.failed.installExternal")}</p>
            <div className="player__message-actions">
              {media.ffmpegInstalled === false && (
                <button className="button button--primary" disabled={media.installing} onClick={media.install}>
                  {media.installing
                    ? t("player.convert.installing", { percent: Math.round(media.installProgress * 100) })
                    : t("player.convert.install", { size: formatBytes(media.installBytes) })}
                </button>
              )}
              {externalPlayer && (
                <button className="button button--primary" onClick={() => void openExternally()}>
                  <ExternalLink size={16} />
                  {t("player.openIn", { player: externalPlayer })}
                </button>
              )}
              {sources.length > 1 && (
                <button className="button" onClick={() => setMenu("quality")}>
                  {t("player.otherQuality")}
                </button>
              )}
            </div>
          </div>
        ) : countdown !== null && nextEpisode ? (
          <div className="player__message">
            <strong>{t("player.next.countdown", { seconds: countdown })}</strong>
            <p>
              {nextEpisode.episode}. {nextEpisode.name}
            </p>
            <div className="player__message-actions">
              <button className="button button--primary" onClick={playNext}>
                <SkipForward size={16} />
                {t("player.next.watchNow")}
              </button>
              <button className="button" onClick={() => setCountdown(null)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : ended ? (
          <div className="player__message">
            <strong>{t("player.ended")}</strong>
            <div className="player__message-actions">
              <button className="button" onClick={() => seekTo(0)}>
                <RotateCcw size={16} />
                {t("player.restart")}
              </button>
              <button className="button button--primary" onClick={close}>
                {t("common.close")}
              </button>
            </div>
          </div>
        ) : buffering ? (
          <div className="player__buffering">
            <LoaderCircle size={46} className="spin" />
            {torrent && downloaded < 1 && (
              <span>
                {torrent.peers > 0
                  ? t("player.buffering.loading", { speed: formatSpeed(torrent.downloadSpeed), peers: torrent.peers })
                  : t("player.buffering.searching")}
              </span>
            )}
          </div>
        ) : null}
      </div>

      {hint && (
        <div className="player__hint" key={hint.id}>
          {hint.text}
        </div>
      )}

      {!failed && (media.installing || (silentAudio && media.ffmpegInstalled === false)) && (
        <div className="player__notice">
          <TriangleAlert size={16} />
          {media.installing ? (
            <span>{t("player.audioModule.downloading", { percent: Math.round(media.installProgress * 100) })}</span>
          ) : (
            <>
              <span>
                {media.installFailed
                  ? t("player.audioModule.failed")
                  : t("player.audioModule.needed", { size: formatBytes(media.installBytes) })}
              </span>
              <button className="button button--small button--primary" onClick={media.install}>
                {media.installFailed ? t("common.retry") : t("player.audioModule.install")}
              </button>
              {externalPlayer && (
                <button className="button button--small" onClick={() => void openExternally()}>
                  {t("player.openIn", { player: externalPlayer })}
                </button>
              )}
              <button className="button button--small" onClick={() => setSilentAudio(false)}>
                {t("player.hide")}
              </button>
            </>
          )}
        </div>
      )}

      {onlinePanel && (
        <div className="player__panel" role="dialog" aria-label={t("player.subtitles.online.title")}>
          <div className="player__panel-head">
            <div>
              <strong>{t("player.subtitles.online.title")}</strong>
              <p>{t("player.subtitles.online.hint")}</p>
            </div>
            <button className="icon-button" aria-label={t("common.close")} onClick={() => setOnlinePanel(false)}>
              <X size={18} />
            </button>
          </div>
          {online.loading && (
            <div className="player__panel-state">
              <LoaderCircle size={22} className="spin" />
              {t("player.subtitles.online.searching")}
            </div>
          )}
          {online.error && <div className="player__panel-state">{online.error}</div>}
          {online.items?.length === 0 && <div className="player__panel-state">{t("player.subtitles.online.none")}</div>}
          {online.items && online.items.length > 0 && (
            <>
              <div className="player__panel-languages">
                {[...new Set(online.items.map((item) => item.language))].map((code) => (
                  <button key={code} className={`chip ${code === onlineLanguage ? "is-active" : ""}`} onClick={() => setOnlineLanguage(code)}>
                    {languageName(code, locale) || code}
                    <small>{online.items?.filter((item) => item.language === code).length}</small>
                  </button>
                ))}
              </div>
              <div className="player__panel-list">
                {online.items
                  .filter((item) => item.language === onlineLanguage)
                  .map((item) => (
                    <button
                      key={item.fileId}
                      className={`player__panel-item ${subtitleKey === `online:${item.fileId}` ? "is-chosen" : ""}`}
                      onClick={() => void loadOnlineSubtitle(item)}
                    >
                      <span className="player__panel-release">{item.release || t("player.subtitles.online.unnamed")}</span>
                      <span className="player__panel-badges">
                        {item.sameRelease && <em className="is-match">{t("player.subtitles.online.sameRelease")}</em>}
                        {item.hearingImpaired && <em>{t("player.subtitles.online.sdh")}</em>}
                        {item.machineTranslated && <em>{t("player.subtitles.online.machine")}</em>}
                        <small title={t("player.subtitles.online.downloads")}>↓ {item.downloads.toLocaleString(locale)}</small>
                      </span>
                    </button>
                  ))}
              </div>
            </>
          )}
        </div>
      )}

      {skippable && !failed && (
        <button className="player__skip" onClick={() => seekTo(skippable.end)}>
          <SkipForward size={16} />
          {t(`player.skip.${skipKind(skippable) ?? "intro"}`)}
        </button>
      )}

      <div className="player__bottom">
        <SeekBar current={current} duration={duration} buffered={bufferedAhead} chapters={chapters} onSeek={seekTo} />
        <div className="player__controls">
          <button className="player__button player__button--main" aria-label={playing ? t("player.pause") : t("player.play")} onClick={togglePlay}>
            {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
          </button>
          <button className="player__button" aria-label={t("player.seekBack")} onClick={() => seekBy(-seekStepSeconds)}>
            <RotateCcw size={19} />
          </button>
          <button className="player__button" aria-label={t("player.seekForward")} onClick={() => seekBy(seekStepSeconds)}>
            <RotateCw size={19} />
          </button>
          {nextEpisode && (
            <button className="player__button" aria-label={t("player.next")} title={t("player.next.named", { name: nextEpisode.name })} onClick={playNext}>
              <SkipForward size={19} />
            </button>
          )}
          <div className="player__volume">
            <button className="player__button" aria-label={t("player.sound")} onClick={() => setMuted((value) => !value)}>
              <VolumeIcon size={19} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              aria-label={t("player.volume")}
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

          <button className={`player__button ${cues.length > 0 ? "is-on" : ""}`} aria-label={t("common.subtitles")} onClick={() => setMenu(menu === "subtitles" ? null : "subtitles")}>
            <Captions size={20} />
          </button>
          {(audio.options.length > 0 || (media.tracks?.audio.length ?? 0) > 1) && (
            <button className="player__button" aria-label={t("player.audioTrack")} onClick={() => setMenu(menu === "audio" ? null : "audio")}>
              <AudioLines size={19} />
            </button>
          )}
          <button className="player__button" aria-label={t("player.speed")} onClick={() => setMenu(menu === "speed" ? null : "speed")}>
            <Gauge size={19} />
            {rate !== 1 && <small>{rate}×</small>}
          </button>
          <button className="player__button player__button--quality" aria-label={t("player.quality")} onClick={() => setMenu(menu === "quality" ? null : "quality")}>
            <Settings2 size={19} />
            <small>{source.quality || t("common.video")}</small>
          </button>
          {isDesktop && (
            <button className="player__button player__button--mini" aria-label={mini ? t("player.mini.exit") : t("player.mini.enter")} title={mini ? t("player.mini.exit") : t("player.mini.enter")} onClick={toggleMini}>
              <PictureInPicture2 size={19} />
            </button>
          )}
          <button className="player__button" aria-label={fullscreen ? t("player.fullscreen.exit") : t("player.fullscreen.enter")} onClick={toggleFullscreen}>
            {fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}
          </button>
        </div>

        {menu === "quality" && (
          <div className="player__menu">
            <h3>{t("player.quality")}</h3>
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
                <span>{t("player.openIn", { player: externalPlayer })}</span>
              </button>
            )}
          </div>
        )}
        {menu === "audio" && (
          <div className="player__menu">
            <h3>{t("player.audioTrack")}</h3>
            {media.tracks && media.tracks.audio.length > 0
              ? media.tracks.audio.map((option) => (
                  <button key={option.index} className="player__menu-item" onClick={() => chooseAudioTrack(option)}>
                    {option.index === audioTrack ? <Check size={15} /> : <i />}
                    <span>{audioTrackLabel(option, locale)}</span>
                  </button>
                ))
              : audio.options.map((option) => (
                  <button key={option.index} className="player__menu-item" onClick={() => selectAudio(option.index)}>
                    {option.index === audio.selected ? <Check size={15} /> : <i />}
                    <span>{option.label}</span>
                  </button>
                ))}
            {media.tracks && audioTrack !== null && (
              <>
              <h3>{t("player.delay.audio")}</h3>
              <div className="player__menu-row player__delay">
                <button className="chip" aria-label={t("player.delay.earlier")} title={t("player.delay.earlier")} onClick={() => shiftAudio(-delayStepSeconds)}>
                  −
                </button>
                <span>{formatDelay(audioDelay)}</span>
                <button className="chip" aria-label={t("player.delay.later")} title={t("player.delay.later")} onClick={() => shiftAudio(delayStepSeconds)}>
                  +
                </button>
                {audioDelay !== 0 && (
                  <button className="chip" onClick={() => shiftAudio(0)}>
                    {t("player.delay.reset")}
                  </button>
                )}
              </div>
              </>
            )}
          </div>
        )}
        {menu === "speed" && (
          <div className="player__menu">
            <h3>{t("player.speed")}</h3>
            {playbackRates.map((value) => (
              <button key={value} className="player__menu-item" onClick={() => selectRate(value)}>
                {value === rate ? <Check size={15} /> : <i />}
                <span>{value === 1 ? t("player.speed.normal") : `${value}×`}</span>
              </button>
            ))}
          </div>
        )}
        {menu === "subtitles" && (
          <div className="player__menu">
            <h3>{t("common.subtitles")}</h3>
            <button className="player__menu-item" onClick={disableSubtitles}>
              {subtitleKey === null ? <Check size={15} /> : <i />}
              <span>{t("player.subtitles.off")}</span>
            </button>
            {(media.tracks?.subtitles ?? [])
              .filter((track) => track.isText)
              .map((track) => (
                <button key={`embedded:${track.index}`} className="player__menu-item" onClick={() => selectEmbeddedSubtitle(track, true)}>
                  {subtitleKey === `embedded:${track.index}` ? <Check size={15} /> : <i />}
                  <span>{embeddedSubtitleLabel(track, locale)}</span>
                  <small>
                    {[track.title, showsSignsOnly(track) ? t("player.subtitles.signsOnly") : "", t("player.subtitles.embedded")]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </button>
              ))}
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
              <span>{t("player.subtitles.loadFile")}</span>
            </button>
            {onlineSubtitlesKey && (
              <button className="player__menu-item" onClick={() => void findOnlineSubtitles()}>
                <i />
                <span>{t("player.subtitles.online")}</span>
              </button>
            )}
            {subtitleKey !== null && (
              <>
              <h3>{t("player.delay.subtitles")}</h3>
              <div className="player__menu-row player__delay">
                <button className="chip" aria-label={t("player.delay.earlier")} title={t("player.delay.earlier")} onClick={() => shiftSubtitles(-delayStepSeconds)}>
                  −
                </button>
                <span>{formatDelay(subtitleDelay)}</span>
                <button className="chip" aria-label={t("player.delay.later")} title={t("player.delay.later")} onClick={() => shiftSubtitles(delayStepSeconds)}>
                  +
                </button>
                {subtitleDelay !== 0 && (
                  <button className="chip" onClick={() => shiftSubtitles(0)}>
                    {t("player.delay.reset")}
                  </button>
                )}
              </div>
              </>
            )}
            <h3>{t("player.subtitles.size")}</h3>
            <div className="player__menu-row">
              {subtitleScales.map((scale) => (
                <button
                  key={scale.value}
                  className={`chip ${settings.subtitleScale === scale.value ? "is-active" : ""}`}
                  onClick={() => settings.patch({ subtitleScale: scale.value })}
                >
                  {t(scale.label)}
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
  const { t } = useT();
  return (
    <button className="player__menu-item" onClick={onPick}>
      {active ? <Check size={15} /> : <i />}
      <span>
        {source.quality || t("common.video")}
        {source.tags.length > 0 && <em> {source.tags.join(" · ")}</em>}
      </span>
      <small>
        {resolution && `${resolution} · `}
        {formatBytes(source.size)} · {progress >= 1 ? t("common.downloaded") : `${Math.floor(progress * 100)}%`}
      </small>
    </button>
  );
}

export function Player() {
  const session = useUi((state) => state.player);
  if (!session) return null;
  return <PlayerView key={session.unitKey} session={session} />;
}
