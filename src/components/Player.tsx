import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowLeft,
  AudioLines,
  Camera,
  Captions,
  Check,
  ExternalLink,
  Frame,
  Gauge,
  ListVideo,
  LoaderCircle,
  Maximize,
  PictureInPicture2,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Settings2,
  SkipBack,
  SkipForward,
  TriangleAlert,
  Users,
  Volume1,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  backend,
  convertedStreamUrl,
  describeError,
  getAppInfo,
  isDesktop,
  streamUrl,
  thumbnailUrl,
  type AudioTrackInfo,
  type Chapter,
  type OnlineSubtitle,
  type PrintTarget,
  type SoundSegments,
  type SubtitleTrackInfo,
  type TorrentFile,
} from "../lib/backend";
import { t, useT, type MessageKey } from "../lib/i18n";
import { languageCode, languageName, threeLetterCodes } from "../lib/languages";
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
import { imageUrl, tmdb, type Episode } from "../lib/tmdb";
import { useAsync } from "../lib/useAsync";
import { sortSources } from "../pages/Title";
import { useSoundSegments } from "./useSoundSegments";
import { PlayerEpisodes } from "./PlayerEpisodes";
import { isWatched, titleKey, unitKey, useLibrary, type Source } from "../state/library";
import { useSettings, type SubtitleBackground, type SubtitleColor, type SubtitleFont, type VideoQuality } from "../state/settings";
import { fileProgress, useTorrents } from "../state/torrents";
import { useUi, type PlayerSession } from "../state/ui";
import { report } from "../lib/journal";
import { mpv } from "../lib/mpv";
import { HotkeyList } from "./HotkeyList";
import { WindowButtons } from "./Shell";
import { useConvertedAudio } from "./useConvertedAudio";
import { useEmbeddedSubtitles, useMediaTracks, type MediaTracksState } from "./useMediaTracks";
import { useMpvMode, useMpvVideo, type MediaHandlers } from "./useMpvVideo";
import { useAudioEffects } from "./player/audioEffects";
import { useMediaSession } from "./player/mediaSession";
import { StatsPanel } from "./player/StatsPanel";
import { isLinux, isMac } from "../lib/platform";

const controlsHideDelayMs = 3000;
const progressSaveIntervalMs = 5000;
const seekStepSeconds = 10;
const longSeekStepSeconds = 60;
const volumeStep = 0.05;
const volumeMax = 1.5;
const zoomStep = 0.1;
const zoomMin = 1;
const zoomMax = 3;
const aspectChoices = ["auto", "16:9", "4:3", "21:9", "2.35:1", "1:1"] as const;
type AspectChoice = (typeof aspectChoices)[number];
const thumbnailWidth = 240;
const thumbnailHoverDelayMs = 90;
const thumbnailBuckets = 160;
const thumbnailMinStepSeconds = 4;
const pieceBuckets = 240;
const pieceRefreshMs = 2000;
const chapterRestartSeconds = 3;
const hashWaitMs = 6000;
const stallLongSeconds = 20;
const stallWindowMs = 3 * 60 * 1000;
const stallsToSuggest = 3;
const healthCheckMs = 5000;
const droppedFramesPerCheck = 25;
const badChecksToSimplify = 2;
const qualitySteps: VideoQuality[] = ["high", "balanced", "fast"];
const qualityProperties: Record<VideoQuality, [string, unknown][]> = {
  high: [["scale", "ewa_lanczossharp"], ["dscale", "mitchell"], ["cscale", "spline36"], ["deband", true]],
  balanced: [["scale", "spline36"], ["dscale", "mitchell"], ["cscale", "spline36"], ["deband", false]],
  fast: [["scale", "bilinear"], ["dscale", "bilinear"], ["cscale", "bilinear"], ["deband", false]],
};
const subtitleFonts: Record<SubtitleFont, { mpv: string; css: string }> = {
  sans: { mpv: isMac ? "Helvetica Neue Medium" : "Segoe UI Semibold", css: "system-ui, 'Segoe UI', 'Noto Sans', sans-serif" },
  serif: { mpv: "Georgia", css: "Georgia, 'Noto Serif', 'DejaVu Serif', serif" },
  rounded: { mpv: "Trebuchet MS", css: "'Trebuchet MS', 'Nunito', 'Ubuntu', sans-serif" },
  condensed: {
    mpv: isMac ? "Avenir Next Condensed Demi Bold" : "Bahnschrift SemiCondensed",
    css: "'Bahnschrift SemiCondensed', 'Roboto Condensed', 'Arial Narrow', sans-serif",
  },
};
const subtitleColors: Record<SubtitleColor, string> = { white: "#FFFFFF", yellow: "#FFE45C", cyan: "#8FE6FF", green: "#A6FF8F" };
const seekRunGapMs = 1000;
const hintLifetimeMs = 900;
const releaseDelayMs = 1500;
const builtInAudioCodecs = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const subtitlesOff = "off";
const convertedVideoCodecs = new Set(["mpeg4", "msmpeg4v2", "msmpeg4v3", "mpeg2video", "mpeg1video", "wmv1", "wmv2", "wmv3", "vc1", "rv30", "rv40", "flv1", "h263", "theora"]);

const delayStepSeconds = 0.1;
const longestDelaySeconds = 10;
const skipOfferEndsSeconds = 2;

const skippableChapters: { kind: "intro" | "credits" | "recap"; pattern: RegExp }[] = [
  { kind: "intro", pattern: /\b(intro|opening|op)\b|заставк|опенинг/i },
  { kind: "credits", pattern: /\b(credits|ending|ed|outro)\b|титр|эндинг/i },
  { kind: "recap", pattern: /\b(recap|previously)\b|ранее|в предыдущ/i },
];

type SkipKind = "intro" | "credits" | "recap";

interface SkipSegment {
  kind: SkipKind;
  start: number;
  end: number;
  sceneAfter: boolean;
}

const sceneAfterShortestSeconds = 15;
const soundNeighbourOffsets = [-1, 1, -2, 2];
const soundNeighboursUsed = 3;

function skipKind(chapter: Chapter): SkipKind | null {
  return skippableChapters.find(({ pattern }) => pattern.test(chapter.title))?.kind ?? null;
}

function skipSegments(chapters: Chapter[], sound: SoundSegments | null, duration: number): SkipSegment[] {
  const segments: SkipSegment[] = chapters.flatMap((chapter) => {
    const kind = skipKind(chapter);
    if (!kind) return [];
    const sceneAfter = kind === "credits" && duration > 0 && chapter.end < duration - sceneAfterShortestSeconds;
    return [{ kind, start: chapter.start, end: chapter.end, sceneAfter }];
  });
  if (sound?.intro && !segments.some((segment) => segment.kind === "intro")) {
    segments.push({ kind: "intro", start: sound.intro.start, end: sound.intro.end, sceneAfter: false });
  }
  if (sound?.credits && !segments.some((segment) => segment.kind === "credits")) {
    segments.push({ kind: "credits", start: sound.credits.start, end: sound.credits.end, sceneAfter: sound.credits.sceneAfter });
  }
  return segments.sort((a, b) => a.start - b.start);
}

const onlineSubtitlesKey: string = import.meta.env.VITE_OPENSUBTITLES_API_KEY ?? "";
const sameReleaseWords = 3;
const onlineSubtitleErrors = ["subtitles_key_invalid", "subtitles_quota", "subtitles_unavailable"] as const;

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
const minResumeSeconds = 15;
const originalLanguageWaitMs = 2500;
const probeWaitMs = 1500;
const heldStartLimitMs = 4000;
const originalTrackTitle = /оригинал|original|\borig\b/i;
const commentaryTrackTitle = /коммент|comment/i;
const nextEpisodeCountdownSeconds = 8;
const stuckEndSeconds = 1.5;
const stuckEndWaitMs = 2500;
const interpolationLimitSeconds = 1.5;
const clockStepSeconds = 0.25;
const naturalStepSeconds = 2;
const upNextTailSeconds = 40;
const upNextCountdownSeconds = 10;
const upNextMinDurationSeconds = 5 * 60;
const upNextPreloadBytes = 16 * 1024 * 1024;
const silentAudioCheckDelayMs = 5000;
const settingsSaveDelayMs = 400;
const maxTorrentSubtitles = 12;
const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2];
const subtitleScales: { label: MessageKey; value: number }[] = [
  { label: "player.subtitles.size.small", value: 0.8 },
  { label: "player.subtitles.size.normal", value: 1 },
  { label: "player.subtitles.size.large", value: 1.3 },
];

type Menu = "quality" | "audio" | "subtitles" | "speed" | "picture" | null;

function subtitleMpvProperties(font: SubtitleFont, color: SubtitleColor, background: SubtitleBackground, raise: number): [string, unknown][] {
  const box = background === "box";
  return [
    ["sub-font", subtitleFonts[font].mpv],
    ["sub-color", subtitleColors[color]],
    ["sub-border-style", box ? "background-box" : "outline-and-shadow"],
    ["sub-back-color", box ? "#B0000000" : "#00000000"],
    ["sub-border-color", "#000000"],
    ["sub-border-size", box ? 3 : background === "shadow" ? 0.6 : 2.5],
    ["sub-shadow-offset", background === "shadow" ? 2.5 : box ? 0 : 1],
    ["sub-pos", Math.round(100 - raise)],
  ];
}

function aspectRatioValue(aspect: AspectChoice): string {
  return aspect === "auto" ? "-1" : aspect;
}

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

function pickInitialSource(sources: Source[], preferredId: string | undefined, maxQuality: number): Source | undefined {
  const preferred = sources.find((source) => source.id === preferredId);
  if (preferred || sources.length === 0) return preferred;
  const { byHash } = useTorrents.getState();
  const isReady = (source: Source) => fileProgress(byHash[source.infoHash], source.fileIndex) >= 1;

  if (maxQuality > 0) {
    const within = sources.filter((source) => qualityRank(source.quality) <= maxQuality);
    const pool = within.length > 0 ? within : sources.slice(-1);
    const top = qualityRank(pool[0].quality);
    const sameQuality = pool.filter((source) => qualityRank(source.quality) === top);
    return sameQuality.find(isReady) ?? sameQuality[0];
  }
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

function audioTrackLabel(track: AudioTrackInfo, locale: string): string {
  const format = [track.codec.toUpperCase(), track.channels.replace(/\(.*\)/, "")].filter(Boolean).join(" ");
  const language = languageName(languageCode(track.language), locale);
  return [language, track.title, format].filter(Boolean).join(" · ") || t("player.track", { number: track.index + 1 });
}

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

function PieceMap({ pieces }: { pieces: number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = pieces.length;
    canvas.height = 1;
    context.clearRect(0, 0, canvas.width, 1);
    pieces.forEach((value, index) => {
      if (value === 0) return;
      context.fillStyle = `rgba(255, 255, 255, ${(value / 255).toFixed(3)})`;
      context.fillRect(index, 0, 1, 1);
    });
  }, [pieces]);
  return <canvas ref={canvasRef} className="seek__pieces" aria-hidden="true" />;
}

function SeekPreview({ time, thumbnail }: { time: number; thumbnail: (seconds: number) => Promise<string> }) {
  const [src, setSrc] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void thumbnail(time).then((url) => {
        if (!cancelled) setSrc(url);
      });
    }, thumbnailHoverDelayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [time, thumbnail]);
  if (!src) return null;
  return (
    <img
      className={`seek__preview ${shown ? "is-shown" : ""}`}
      src={src}
      alt=""
      draggable={false}
      onLoad={() => setShown(true)}
      onError={() => setShown(false)}
    />
  );
}

function SeekBar({
  current,
  duration,
  buffered,
  pieces,
  chapters,
  advancing,
  rate,
  thumbnail,
  onSeek,
}: {
  current: number;
  duration: number;
  buffered: { start: number; end: number }[];
  pieces: number[] | null;
  chapters: Chapter[];
  advancing: boolean;
  rate: number;
  thumbnail: ((seconds: number) => Promise<string>) | null;
  onSeek: (time: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const anchor = useRef({ time: current, at: performance.now() });
  const previewStep = Math.max(thumbnailMinStepSeconds, duration / thumbnailBuckets);
  const previewAt = (ratio: number) => Math.min(Math.max(0, duration - 1), Math.round((ratio * duration) / previewStep) * previewStep);

  useEffect(() => {
    anchor.current = { time: current, at: performance.now() };
  }, [current]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const safe = duration > 0 ? duration : 1;
    const paint = (time: number) => track.style.setProperty("--played", String(Math.min(1, Math.max(0, time / safe))));
    if (drag !== null) {
      track.style.setProperty("--played", String(drag));
      return;
    }
    if (!advancing) {
      paint(current);
      return;
    }
    let frame = 0;
    const step = () => {
      const { time, at } = anchor.current;
      const elapsed = Math.min(interpolationLimitSeconds, (performance.now() - at) / 1000);
      paint(time + elapsed * rate);
      frame = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(frame);
  }, [advancing, rate, duration, drag, current]);

  const ratioAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

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
        {pieces && <PieceMap pieces={pieces} />}
        {buffered.map((range) => (
          <i
            key={range.start}
            className="seek__buffered"
            style={{ left: `${(range.start / safeDuration) * 100}%`, width: `${((range.end - range.start) / safeDuration) * 100}%` }}
          />
        ))}
        <i className="seek__played" />
        {chapters.slice(1).map((chapter) => (
          <i key={chapter.start} className="seek__chapter" style={{ left: `${(chapter.start / safeDuration) * 100}%` }} />
        ))}
        <i className="seek__thumb" />
      </div>
      {hover !== null && duration > 0 && (
        <span className={`seek__tooltip ${thumbnail ? "has-preview" : ""}`} style={{ left: `${hover * 100}%` }}>
          {thumbnail && <SeekPreview time={previewAt(drag ?? hover)} thumbnail={thumbnail} />}
          {formatClock((drag ?? hover) * duration)}
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
  const shownTime = useRef(0);
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

  const [metadataReady, setMetadataReady] = useState(false);
  const mpvChoice = useMpvMode();
  const usingMpv = mpvChoice.mode === "ready";
  const mpvPlayer = useMpvVideo(usingMpv);
  if (usingMpv) (videoRef as { current: VideoWithExtras | null }).current = mpvPlayer.video as unknown as VideoWithExtras;
  const htmlMedia = useMediaTracks(mpvChoice.mode === "unavailable" || usingMpv ? (source ?? null) : null);
  const probed = htmlMedia.tracks;
  const mpvTracks = useMemo(() => {
    const own = mpvPlayer.tracks;
    if (!own || !probed || probed.audio.length !== own.audio.length) return own;
    return { ...own, audio: own.audio.map((track, index) => ({ ...track, isOriginal: probed.audio[index].isOriginal })) };
  }, [mpvPlayer.tracks, probed]);
  const media: MediaTracksState = usingMpv
    ? { tracks: mpvTracks, ffmpegInstalled: true, installing: false, installProgress: 0, installBytes: 0, installFailed: false, install: () => undefined }
    : htmlMedia;
  const titleDetails = useAsync(() => tmdb.details(session.title.type, session.title.id), [session.title.type, session.title.id]);
  const originalLanguage = languageCode(titleDetails.data?.language);
  const [originalWaitOver, setOriginalWaitOver] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setOriginalWaitOver(true), originalLanguageWaitMs);
    return () => clearTimeout(timer);
  }, []);
  const originalSettled = !titleDetails.loading || originalWaitOver;
  const [startHeld, setStartHeld] = useState(false);
  const externalSubtitle = useRef<{ path?: string; text?: string; title: string } | null>(null);
  const [audioTrack, setAudioTrack] = useState<number | null>(null);
  const [convertedTrack, setConvertedTrack] = useState<number | null>(null);
  const [embeddedSubtitle, setEmbeddedSubtitle] = useState<number | null>(null);
  const preferencesKey = titleKey(session.title.type, session.title.id);
  const preferences = useLibrary((state) => state.preferences[preferencesKey]);
  const rememberForTitle = useLibrary((state) => state.setTitlePreferences);
  const [subtitleDelay, setSubtitleDelay] = useState(preferences?.subtitleDelay ?? 0);
  const [audioDelay, setAudioDelay] = useState(preferences?.audioDelay ?? 0);
  const chapters = media.tracks?.chapters ?? [];

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
  const heardConverted = usingMpv || conversionStart !== null ? null : (convertedTrack ?? (audioDelay !== 0 ? audioTrack : null));
  const pickedAudio = useRef(false);
  const subtitlesDecided = useRef(false);
  const [hint, setHint] = useState<{ text: string; id: number } | null>(null);
  const [onlinePanel, setOnlinePanel] = useState(false);
  const [hotkeysShown, setHotkeysShown] = useState(false);
  const [onlineLanguage, setOnlineLanguage] = useState("");
  const [statsShown, setStatsShown] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [aspect, setAspect] = useState<AspectChoice>("auto");
  const [secondary, setSecondary] = useState<{ key: string; label: string } | null>(null);
  const [secondaryCues, setSecondaryCues] = useState<Cue[]>([]);
  const [secondaryText, setSecondaryText] = useState("");
  const [secondaryEmbedded, setSecondaryEmbedded] = useState<number | null>(null);
  const [pieces, setPieces] = useState<number[] | null>(null);
  const [sessionQuality, setSessionQuality] = useState<VideoQuality>(settings.videoQuality);
  const [slowSource, setSlowSource] = useState(false);
  const [slowDismissed, setSlowDismissed] = useState(false);
  const lastSeekAt = useRef(0);

  const resumeAt = useRef<number>(
    (() => {
      const saved = useLibrary.getState().progress[session.unitKey];
      return saved && !isWatched(saved) && saved.position >= minResumeSeconds ? saved.position : 0;
    })(),
  );
  const playedSeconds = useRef<number>(
    (() => {
      const saved = useLibrary.getState().progress[session.unitKey];
      if (!saved || (saved.duration === 1 && saved.position === 1)) return 0;
      return saved.played ?? saved.position;
    })(),
  );
  const lastPlayedAt = useRef<number | null>(null);

  const seasonEpisodes = useAsync(
    () => (session.season !== undefined ? tmdb.season(session.title.id, session.season) : Promise.resolve([])),
    [session.title.id, session.season],
  );
  const regularSeasons = useMemo(
    () =>
      (titleDetails.data?.seasons ?? [])
        .map((season) => season.seasonNumber)
        .filter((number) => number > 0)
        .sort((a, b) => a - b),
    [titleDetails.data],
  );
  const seasonPlace = session.season === undefined ? -1 : regularSeasons.indexOf(session.season);
  const seasonAfter = seasonPlace >= 0 ? regularSeasons[seasonPlace + 1] : undefined;
  const seasonBefore = seasonPlace > 0 ? regularSeasons[seasonPlace - 1] : undefined;
  const inSeason = seasonEpisodes.data ?? [];
  const laterInSeason = session.episode === undefined ? [] : inSeason.filter((episode) => episode.episode > session.episode!);
  const earlierInSeason = session.episode === undefined ? [] : inSeason.filter((episode) => episode.episode < session.episode!);
  const needAfter = seasonEpisodes.data !== null && seasonEpisodes.data !== undefined && laterInSeason.length === 0 && seasonAfter !== undefined;
  const needBefore = seasonEpisodes.data !== null && seasonEpisodes.data !== undefined && earlierInSeason.length === 0 && seasonBefore !== undefined;
  const afterEpisodes = useAsync(
    () => (needAfter ? tmdb.season(session.title.id, seasonAfter!) : Promise.resolve([] as Episode[])),
    [session.title.id, needAfter, seasonAfter],
  );
  const beforeEpisodes = useAsync(
    () => (needBefore ? tmdb.season(session.title.id, seasonBefore!) : Promise.resolve([] as Episode[])),
    [session.title.id, needBefore, seasonBefore],
  );
  const hasSource = useCallback(
    (episode: Episode) => (allSources[unitKey("tv", session.title.id, episode.season, episode.episode)] ?? []).length > 0,
    [allSources, session.title.id],
  );
  const nextCandidate = useMemo<Episode | null>(() => {
    if (session.episode === undefined) return null;
    const sameSeason = [...laterInSeason].sort((a, b) => a.episode - b.episode)[0];
    if (sameSeason) return sameSeason;
    return [...(afterEpisodes.data ?? [])].sort((a, b) => a.episode - b.episode)[0] ?? null;
  }, [laterInSeason, afterEpisodes.data, session.episode]);
  const previousCandidate = useMemo<Episode | null>(() => {
    if (session.episode === undefined) return null;
    const sameSeason = [...earlierInSeason].sort((a, b) => b.episode - a.episode)[0];
    if (sameSeason) return sameSeason;
    return [...(beforeEpisodes.data ?? [])].sort((a, b) => b.episode - a.episode)[0] ?? null;
  }, [earlierInSeason, beforeEpisodes.data, session.episode]);
  const nextEpisode = nextCandidate && hasSource(nextCandidate) ? nextCandidate : null;
  const previousEpisode = previousCandidate && hasSource(previousCandidate) ? previousCandidate : null;
  const [episodesShown, setEpisodesShown] = useState(false);

  const soundNeighbours = useMemo<PrintTarget[]>(() => {
    if (session.season === undefined || session.episode === undefined || !source) return [];
    const found: PrintTarget[] = [];
    for (const offset of soundNeighbourOffsets) {
      const list = sortSources(allSources[unitKey("tv", session.title.id, session.season, session.episode + offset)] ?? []);
      const pick = list.find((item) => item.infoHash === source.infoHash) ?? pickInitialSource(list, undefined, settings.preferredQuality);
      if (pick && found.length < soundNeighboursUsed) found.push({ infoHash: pick.infoHash, fileIndex: pick.fileIndex });
    }
    return found;
  }, [allSources, session.title.id, session.season, session.episode, source, settings.preferredQuality]);
  const chapterKinds = new Set(chapters.map(skipKind));
  const soundSegments = useSoundSegments({
    enabled: settings.soundSegments && metadataReady,
    target: source ? { infoHash: source.infoHash, fileIndex: source.fileIndex } : null,
    neighbours: soundNeighbours,
    duration,
    current,
    startAt: resumeAt.current,
    playing,
    buffering,
    needIntro: !chapterKinds.has("intro"),
    needCredits: !chapterKinds.has("credits"),
  });
  const segments = useMemo(() => skipSegments(chapters, soundSegments, duration), [chapters, soundSegments, duration]);
  const skippable = segments.find((segment) => current >= segment.start && current < segment.end - skipOfferEndsSeconds);

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
    subtitlesDecided.current = externalSubtitle.current !== null;
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

  useEffect(() => {
    const video = videoRef.current;
    // WebKit keeps a detached <video> loading (and re-polling an HLS playlist, which restarts the conversion) until its source is cleared.
    return () => {
      video?.removeAttribute("src");
      video?.load();
    };
  }, [url]);

  const startConversion = useCallback(() => {
    setFailed(false);
    setBuffering(true);
    setConversionStart(resumeAt.current > 0 ? resumeAt.current : filmTime());
  }, [filmTime]);

  // WebKit on macOS stalls on containers it can't open (MKV, AVI...) instead of firing an error, so convert those up front.
  const unplayablePicture =
    convertedVideoCodecs.has(media.tracks?.videoCodec ?? "") || (isMac && !/\.(mp4|m4v|mov)$/i.test(source?.fileName ?? ""));
  useEffect(() => {
    if (!usingMpv && conversionStart === null && media.tracks && (unplayablePicture || failed)) startConversion();
  }, [media.tracks, unplayablePicture, failed]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchToBuiltIn = useCallback(() => {
    const position = filmTime();
    if (position > 1) resumeAt.current = position;
    mpvChoice.fallBack();
    setFailed(false);
    toast(t("player.mpv.fallback"), "info");
  }, [mpvChoice, filmTime, toast, t]);

  const loadedUrl = useRef<string | null>(null);
  useEffect(() => {
    if (!usingMpv || !url || loadedUrl.current === url) return;
    loadedUrl.current = url;
    const wanted = preferences?.audioLanguage || settings.audioLanguage || originalLanguage;
    void mpv.set("alang", wanted ? [wanted, ...threeLetterCodes(wanted)].join(",") : "").catch(() => undefined);
    mpvPlayer.video.prime(volume, muted, rate);
    setStartHeld(true);
    void mpvPlayer.video.load(url, resumeAt.current, true).catch((error) => {
      report("player", "journal.mpv.play", error);
      setStartHeld(false);
      if (String(error).includes("mpv_start_failed") || String(error).includes("mpv_gone")) {
        switchToBuiltIn();
        return;
      }
      setFailed(true);
      setBuffering(false);
    });
  }, [usingMpv, url]); // eslint-disable-line react-hooks/exhaustive-deps

  const releaseStart = useCallback(() => {
    setStartHeld((held) => {
      if (held) void mpvPlayer.video.play();
      return false;
    });
  }, [mpvPlayer.video]);

  useEffect(() => {
    if (!startHeld || !metadataReady) return;
    const timer = setTimeout(releaseStart, heldStartLimitMs);
    return () => clearTimeout(timer);
  }, [startHeld, metadataReady, releaseStart]);

  const generation = mpvPlayer.generation;
  useEffect(() => {
    if (usingMpv && mpv.smoothMotion) void mpv.set("interpolation", settings.smoothMotion).catch(() => undefined);
  }, [usingMpv, settings.smoothMotion, generation]);

  useEffect(() => {
    if (usingMpv) void mpv.set("audio-delay", audioDelay).catch(() => undefined);
  }, [usingMpv, audioDelay, generation]);

  useEffect(() => {
    if (usingMpv) void mpv.set("sub-scale", settings.subtitleScale).catch(() => undefined);
  }, [usingMpv, settings.subtitleScale, generation]);

  useEffect(() => {
    if (!usingMpv) return;
    for (const [name, value] of subtitleMpvProperties(settings.subtitleFont, settings.subtitleColor, settings.subtitleBackground, settings.subtitlePosition)) {
      void mpv.set(name, value).catch(() => undefined);
    }
  }, [usingMpv, settings.subtitleFont, settings.subtitleColor, settings.subtitleBackground, settings.subtitlePosition, generation]);

  useEffect(() => setSessionQuality(settings.videoQuality), [settings.videoQuality]);

  useEffect(() => {
    if (!usingMpv) return;
    for (const [name, value] of qualityProperties[sessionQuality]) void mpv.set(name, value).catch(() => undefined);
  }, [usingMpv, sessionQuality, generation]);

  useEffect(() => {
    if (usingMpv) void mpv.audioFilter(settings.audioMode).catch(() => undefined);
  }, [usingMpv, settings.audioMode, generation]);

  useEffect(() => {
    if (!usingMpv) return;
    void mpv.set("video-zoom", Math.log2(zoom)).catch(() => undefined);
    void mpv.set("video-aspect-override", aspectRatioValue(aspect)).catch(() => undefined);
  }, [usingMpv, zoom, aspect, generation]);

  useEffect(() => {
    if (!isDesktop || !source) return;
    let cancelled = false;
    const load = async () => {
      if (fileProgress(useTorrents.getState().byHash[source.infoHash], source.fileIndex) >= 1) {
        if (!cancelled) setPieces(null);
        return;
      }
      try {
        const map = await backend.torrentFileMap(source.infoHash, source.fileIndex, pieceBuckets);
        if (!cancelled) setPieces(map);
      } catch {
        if (!cancelled) setPieces(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), pieceRefreshMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [source?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const thumbnailSource = isDesktop && htmlMedia.ffmpegInstalled === true ? source : undefined;
  const thumbnail = useMemo(
    () => (thumbnailSource ? (seconds: number) => thumbnailUrl(thumbnailSource.infoHash, thumbnailSource.fileIndex, seconds, thumbnailWidth) : null),
    [thumbnailSource?.infoHash, thumbnailSource?.fileIndex], // eslint-disable-line react-hooks/exhaustive-deps
  );

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
      played: Math.round(Math.min(length, playedSeconds.current)),
    });
  }, [session, filmTime, filmLength]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(saveProgress, progressSaveIntervalMs);
    return () => clearInterval(timer);
  }, [playing, saveProgress]);

  useEffect(() => beforeAppClose(saveProgress), [saveProgress]);

  const playedTorrent = source?.infoHash;
  useEffect(() => {
    if (!playedTorrent) return;
    void backend.holdOnline(playedTorrent);
    const stopOnExit = beforeAppClose(() => backend.releaseOnline(playedTorrent));
    return () => {
      stopOnExit();
      setTimeout(() => void backend.releaseOnline(playedTorrent).then(() => useTorrents.getState().refresh()), releaseDelayMs);
    };
  }, [playedTorrent]);

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
      setConversionStart(target);
      setBuffering(true);
    } else {
      video.currentTime = target;
    }
    setCurrent(target);
    setEnded(false);
    setCountdown(null);
    lastSeekAt.current = Date.now();
  }, []);

  const showHint = useCallback((text: string) => setHint({ text, id: Date.now() }), []);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), hintLifetimeMs);
    return () => clearTimeout(timer);
  }, [hint]);

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

  const credits = segments.find((segment) => segment.kind === "credits" && duration > 0 && segment.start > duration / 2);
  const upNextFrom =
    nextEpisode && duration >= upNextMinDurationSeconds && !credits?.sceneAfter ? (credits?.start ?? duration - upNextTailSeconds) : null;

  const playNext = useCallback(() => {
    if (!nextEpisode) return;
    const length = filmLength();
    if (upNextFrom !== null && filmTime() >= upNextFrom && Number.isFinite(length) && length > 0) {
      useLibrary.getState().setProgress(session.unitKey, {
        position: length,
        duration: length,
        updatedAt: Date.now(),
        title: session.title,
        season: session.season,
        episode: session.episode,
        episodeName: session.episodeName,
        played: Math.round(Math.min(length, playedSeconds.current)),
      });
    } else {
      saveProgress();
    }
    play({
      title: session.title,
      unitKey: unitKey("tv", session.title.id, nextEpisode.season, nextEpisode.episode),
      season: nextEpisode.season,
      episode: nextEpisode.episode,
      episodeName: nextEpisode.name,
    });
  }, [nextEpisode, play, saveProgress, session, upNextFrom, filmTime, filmLength]);

  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [upNextLeft, setUpNextLeft] = useState<number | null>(null);
  useEffect(() => setUpNextDismissed(false), [session.unitKey]);
  const upNextVisible = upNextFrom !== null && current >= upNextFrom && !upNextDismissed && !ended && countdown === null && !failed;

  useEffect(() => {
    if (!upNextVisible || !settings.autoNextEpisode) {
      setUpNextLeft(null);
      return;
    }
    setUpNextLeft((value) => value ?? upNextCountdownSeconds);
  }, [upNextVisible, settings.autoNextEpisode]);

  useEffect(() => {
    if (upNextLeft === null || !playing) return;
    if (upNextLeft <= 0) {
      playNext();
      return;
    }
    const timer = setTimeout(() => setUpNextLeft((value) => (value === null ? null : value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [upNextLeft, playing, playNext]);

  const nextSource = useMemo(() => {
    if (!nextEpisode) return undefined;
    const list = allSources[unitKey("tv", session.title.id, nextEpisode.season, nextEpisode.episode)] ?? [];
    return pickInitialSource(sortSources(list), undefined, settings.preferredQuality);
  }, [nextEpisode, allSources, session.title.id, settings.preferredQuality]);

  useEffect(() => {
    if (!upNextVisible || !nextSource || buffering) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch(await streamUrl(nextSource.infoHash, nextSource.fileIndex), {
          headers: { Range: `bytes=0-${upNextPreloadBytes - 1}` },
          signal: abort.signal,
        });
        const reader = response.body?.getReader();
        if (!reader) return;
        while (!(await reader.read()).done) {
          if (abort.signal.aborted) return;
        }
      } catch {
        return;
      }
    })();
    return () => abort.abort();
  }, [upNextVisible, nextSource?.id, buffering]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleFullscreen = useCallback(() => {
    setFullscreen((value) => {
      void setWindowFullscreen(!value, rootRef.current);
      return !value;
    });
  }, []);

  const [mini, setMini] = useState(false);
  const toggleMini = useCallback(() => {
    setMini((value) => {
      if (!value) {
        setFullscreen(false);
        void setWindowFullscreen(false, rootRef.current).then(() => setMiniWindow(true));
      } else {
        void setMiniWindow(false);
      }
      return !value;
    });
  }, []);
  useEffect(() => () => void setMiniWindow(false), []);


  useEffect(() => {
    const video = videoRef.current;
    if (video && usingMpv) {
      video.volume = volume;
      video.muted = muted;
    }
    const timer = setTimeout(() => useSettings.getState().patch({ volume, muted }), settingsSaveDelayMs);
    return () => clearTimeout(timer);
  }, [volume, muted, url, heardConverted, usingMpv]);

  useAudioEffects(videoRef, !usingMpv && mpvChoice.mode === "unavailable", url, settings.audioMode, volume, muted || heardConverted !== null);

  const changeVolume = useCallback(
    (delta: number) => {
      setMuted(false);
      setVolume((value) => {
        const next = Math.min(volumeMax, Math.max(0, Math.round((value + delta) * 100) / 100));
        showHint(t("player.hint.volume", { percent: Math.round(next * 100) }));
        return next;
      });
    },
    [showHint],
  );


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

  const changeZoom = (delta: number) =>
    setZoom((value) => {
      const next = Math.round(Math.min(zoomMax, Math.max(zoomMin, value + delta)) * 10) / 10;
      showHint(t("player.picture.zoomHint", { percent: Math.round(next * 100) }));
      return next;
    });

  const cycleAspect = () =>
    setAspect((value) => {
      const next = aspectChoices[(aspectChoices.indexOf(value) + 1) % aspectChoices.length];
      showHint(next === "auto" ? t("player.picture.aspectAuto") : t("player.picture.aspectHint", { aspect: next }));
      return next;
    });

  const resetPicture = () => {
    setZoom(1);
    setAspect("auto");
    if (rate !== 1) {
      if (videoRef.current) videoRef.current.playbackRate = 1;
      setRate(1);
      rememberForTitle(session.title, { rate: 1 });
    }
    showHint(t("player.picture.resetDone"));
  };

  const jumpChapter = (direction: 1 | -1) => {
    if (chapters.length === 0) return;
    const now = filmTime();
    let target: Chapter | undefined;
    if (direction > 0) {
      target = chapters.find((chapter) => chapter.start > now + 0.5);
    } else {
      const index = chapters.findIndex((chapter) => now >= chapter.start && now < chapter.end);
      const here = chapters[index];
      target = here && now - here.start > chapterRestartSeconds ? here : chapters[Math.max(0, index - 1)];
    }
    if (!target) return;
    seekTo(target.start);
    showHint(target.title || t("player.chapter", { number: chapters.indexOf(target) + 1 }));
  };

  const shotLabel = () => {
    const episode =
      session.episode !== undefined
        ? `S${String(session.season ?? 0).padStart(2, "0")}E${String(session.episode).padStart(2, "0")}`
        : session.title.year;
    return [session.title.title, episode, formatClock(filmTime()).replace(/:/g, "-")].filter(Boolean).join(" ");
  };

  const takeScreenshot = async () => {
    if (!isDesktop) return;
    try {
      let path: string;
      if (usingMpv) {
        path = await mpv.screenshot(shotLabel());
      } else {
        const video = videoRef.current;
        if (!video || !video.videoWidth) return;
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d")?.drawImage(video, 0, 0);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("screenshot_invalid");
        path = await backend.saveScreenshot(new Uint8Array(await blob.arrayBuffer()), shotLabel());
      }
      toast(t("player.screenshot.saved"), "success", {
        label: t("player.screenshot.show"),
        run: () => void import("@tauri-apps/plugin-opener").then(({ revealItemInDir }) => revealItemInDir(path)),
      });
    } catch (error) {
      toast(describeError(error), "error");
    }
  };

  const extraKeys = useRef<Record<string, () => void>>({});
  extraKeys.current = {
    "=": () => changeZoom(zoomStep),
    "+": () => changeZoom(zoomStep),
    "-": () => changeZoom(-zoomStep),
    v: cycleAspect,
    r: resetPicture,
    p: () => void takeScreenshot(),
    d: () => setStatsShown((value) => !value),
    PageDown: () => jumpChapter(1),
    PageUp: () => jumpChapter(-1),
    MediaPlayPause: togglePlay,
    MediaTrackNext: playNext,
    MediaStop: () => videoRef.current?.pause(),
  };


  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
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
        b: () => {
          if (previousEpisode) playEpisode(previousEpisode);
        },
        e: () => {
          if (session.episode !== undefined) setEpisodesShown((value) => !value);
        },
        c: () => setMenu((value) => (value === "subtitles" ? null : "subtitles")),
        a: () => setMenu((value) => (value === "audio" ? null : "audio")),
        "[": () => stepRate(-1),
        "]": () => stepRate(1),
        g: () => shiftSubtitles(-delayStepSeconds),
        h: () => shiftSubtitles(delayStepSeconds),
        s: () => {
          if (skippable) seekTo(skippable.end);
        },
        "?": () => setHotkeysShown((value) => !value),
        Escape: () => {
          if (episodesShown) setEpisodesShown(false);
          else if (hotkeysShown) setHotkeysShown(false);
          else if (statsShown) setStatsShown(false);
          else if (onlinePanel) setOnlinePanel(false);
          else if (menu) setMenu(null);
          else if (fullscreen) toggleFullscreen();
          else close();
        },
      };
      if (/^[0-9]$/.test(event.key) && video && Number.isFinite(filmLength())) {
        event.preventDefault();
        seekTo((filmLength() * Number(event.key)) / 10);
        showHint(`${Number(event.key) * 10}%`);
        wakeControls();
        return;
      }
      const sameKeys: Record<string, string> = { "и": "b", "у": "e", "а": "f", "ь": "m", "л": "k", "о": "j", "д": "l", "т": "n", "с": "c", "ф": "a", "х": "[", "ъ": "]", "п": "g", "р": "h", "ы": "s", "ш": "i", "м": "v", "к": "r", "з": "p", "в": "d" };
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const asksForHelp = event.shiftKey && event.code === "Slash";
      const extra = extraKeys.current;
      const handler = asksForHelp
        ? handlers["?"]
        : (handlers[event.key] ?? handlers[key] ?? handlers[sameKeys[key] ?? ""] ?? extra[event.key] ?? extra[key] ?? extra[sameKeys[key] ?? ""]);
      if (!handler) return;
      event.preventDefault();
      handler();
      wakeControls();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekBy, seekTo, changeVolume, toggleFullscreen, playNext, close, menu, fullscreen, wakeControls, rate, showHint, subtitleDelay, skippable, toggleMini, onlinePanel, hotkeysShown, statsShown, previousEpisode, episodesShown]);


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

  const bufferingNow = useRef(buffering);
  bufferingNow.current = buffering;
  const embeddedCues = useEmbeddedSubtitles(
    () => ({ time: filmTime(), duration: filmLength(), busy: bufferingNow.current }),
    source ?? null,
    usingMpv ? null : embeddedSubtitle,
  );
  const secondaryEmbeddedCues = useEmbeddedSubtitles(
    () => ({ time: filmTime(), duration: filmLength(), busy: bufferingNow.current }),
    source ?? null,
    usingMpv ? null : secondaryEmbedded,
  );

  useEffect(() => {
    if (secondaryEmbedded !== null) setSecondaryCues(secondaryEmbeddedCues);
  }, [secondaryEmbeddedCues, secondaryEmbedded]);

  useEffect(() => {
    if (secondaryCues.length === 0) {
      setSecondaryText("");
      return;
    }
    let frame = 0;
    const update = () => {
      const text = activeCueText(secondaryCues, filmTime() - subtitleDelay);
      setSecondaryText((previous) => (previous === text ? previous : text));
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [secondaryCues, subtitleDelay]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!usingMpv || generation === 0 || !secondary?.key.startsWith("embedded:")) return;
    const index = Number(secondary.key.slice("embedded:".length));
    void mpv.set("secondary-sid", mpvPlayer.video.subtitleId(index) ?? "no").catch(() => undefined);
  }, [generation]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseSecondaryEmbedded = (track: SubtitleTrackInfo) => {
    setSecondary({ key: `embedded:${track.index}`, label: embeddedSubtitleLabel(track, locale) });
    if (usingMpv) {
      void mpv.set("secondary-sid", mpvPlayer.video.subtitleId(track.index) ?? "no").catch((error) => toast(describeError(error), "error"));
    } else {
      setSecondaryCues([]);
      setSecondaryEmbedded(track.index);
    }
    setMenu(null);
  };

  const chooseSecondaryFile = async (option: SubtitleOption) => {
    if (!source) return;
    try {
      const response = await fetch(await streamUrl(source.infoHash, option.file.index));
      if (!response.ok) throw new Error("file_unreadable");
      const parsed = parseSubtitles(decodeSubtitleBytes(await response.arrayBuffer()));
      if (parsed.length === 0) {
        toast(t("player.subtitles.noneInFile"), "error");
        return;
      }
      setSecondaryEmbedded(null);
      setSecondaryCues(parsed);
      setSecondary({ key: option.key, label: option.label });
      setMenu(null);
    } catch (error) {
      toast(describeError(error), "error");
    }
  };

  const clearSecondary = () => {
    setSecondary(null);
    setSecondaryEmbedded(null);
    setSecondaryCues([]);
    if (usingMpv) void mpv.set("secondary-sid", "no").catch(() => undefined);
    setMenu(null);
  };

  useEffect(() => {
    if (usingMpv) void mpv.set("sub-delay", subtitleDelay).catch(() => undefined);
  }, [usingMpv, subtitleDelay, generation]);

  useEffect(() => {
    if (!usingMpv || generation === 0) return;
    if (pickedAudio.current && audioTrack !== null) {
      const id = mpvPlayer.video.audioId(audioTrack);
      if (id !== null) void mpv.set("aid", id).catch(() => undefined);
    }
    const external = externalSubtitle.current;
    if (external) {
      const added = external.path ? mpv.command("sub-add", external.path, "select", external.title) : mpv.addSubtitleText(external.text ?? "", external.title);
      void added.catch((error) => toast(describeError(error), "error"));
    } else if (embeddedSubtitle !== null) {
      void mpv.set("sid", mpvPlayer.video.subtitleId(embeddedSubtitle) ?? "no").catch(() => undefined);
    }
  }, [generation]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!usingMpv || !subtitlesDecided.current || externalSubtitle.current) return;
    const selected = mpvPlayer.video.selectedSubtitle();
    if (selected.kind === "internal" && subtitleKey !== `embedded:${selected.index}`) {
      const track = mpvPlayer.tracks?.subtitles[selected.index];
      setEmbeddedSubtitle(selected.index);
      setSubtitleKey(`embedded:${selected.index}`);
      if (track) setSubtitleLabel(embeddedSubtitleLabel(track, locale));
    } else if (selected.kind === "none" && subtitleKey?.startsWith("embedded:")) {
      setEmbeddedSubtitle(null);
      setSubtitleKey(null);
    }
  }, [mpvPlayer.tracks]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (embeddedSubtitle !== null) setCues(embeddedCues);
  }, [embeddedCues, embeddedSubtitle]);

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

  const formatDelay = (seconds: number) =>
    t("player.delay.value", { seconds: `${seconds > 0 ? "+" : seconds < 0 ? "−" : ""}${Math.abs(seconds).toLocaleString(locale, { minimumFractionDigits: 1 })}` });

  const selectEmbeddedSubtitle = (track: SubtitleTrackInfo, byUser: boolean) => {
    setCues([]);
    externalSubtitle.current = null;
    if (usingMpv) void mpv.set("sid", mpvPlayer.video.subtitleId(track.index) ?? "no").catch((error) => toast(describeError(error), "error"));
    setEmbeddedSubtitle(track.index);
    setSubtitleKey(`embedded:${track.index}`);
    setSubtitleLabel(embeddedSubtitleLabel(track, locale));
    setMenu(null);
    rememberSubtitles(languageCode(track.language), byUser);
  };

  const applySubtitles = (bytes: ArrayBuffer, key: string, label: string) => {
    const text = decodeSubtitleBytes(bytes);
    const parsed = parseSubtitles(text);
    if (parsed.length === 0) {
      toast(t("player.subtitles.noneInFile"), "error");
      return;
    }
    if (usingMpv) {
      setEmbeddedSubtitle(null);
      setCues([]);
      setSubtitleKey(key);
      setSubtitleLabel(label);
      setMenu(null);
      externalSubtitle.current = { text, title: label };
      void mpv.addSubtitleText(text, label).catch((error) => {
        externalSubtitle.current = null;
        setSubtitleKey(null);
        toast(describeError(error), "error");
      });
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
      const picked = await backend.pickFile({ title: t("player.subtitles.fileDialog"), filterName: t("common.subtitles"), extensions: ["srt", "ass", "ssa", "vtt"] });
      if (!picked) return;
      if (usingMpv) {
        await mpv.command("sub-add", picked, "select", baseName(picked));
        externalSubtitle.current = { path: picked, title: baseName(picked) };
        setEmbeddedSubtitle(null);
        setCues([]);
        setSubtitleKey(`disk:${picked}`);
        setSubtitleLabel(baseName(picked));
        setMenu(null);
        return;
      }
      applySubtitles(await backend.readFileBytes(picked), `disk:${picked}`, baseName(picked));
    } catch (error) {
      toast(describeError(error), "error");
    }
  };

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
      const moviehash = isDesktop
        ? await Promise.race([
            backend.subtitleFileHash(source.infoHash, source.fileIndex).catch(() => null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), hashWaitMs)),
          ])
        : null;
      const found = await backend.findOnlineSubtitles(onlineSubtitlesKey, {
        tmdbId: session.title.id,
        season: session.season ?? null,
        episode: session.episode ?? null,
        languages,
        moviehash,
      });
      const playing = releaseWords(`${source.torrentName} ${source.fileName}`);
      const items = found
        .map((item) => ({ ...item, shared: sharedWords(releaseWords(item.release), playing) }))
        .sort(
          (a, b) =>
            Number(b.hashMatch) - Number(a.hashMatch) ||
            Number(b.shared >= sameReleaseWords) - Number(a.shared >= sameReleaseWords) ||
            languages.indexOf(a.language) - languages.indexOf(b.language) ||
            b.shared - a.shared ||
            b.downloads - a.downloads,
        )
        .map(({ shared, ...item }) => ({ ...item, sameRelease: shared >= sameReleaseWords }));
      setOnline({ loading: false, items, error: "" });
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
    externalSubtitle.current = null;
    if (usingMpv) void mpv.set("sid", "no").catch((error) => toast(describeError(error), "error"));
    setEmbeddedSubtitle(null);
    setCues([]);
    setSubtitleKey(null);
    setMenu(null);
    rememberSubtitles(subtitlesOff, true);
  };


  const selectAudio = (index: number) => {
    const video = videoRef.current;
    const tracks = video?.audioTracks;
    if (!video || !tracks) return;
    for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === index;
    video.currentTime = video.currentTime;
    setAudio((value) => ({ ...value, selected: index }));
    setMenu(null);
  };

  const applyAudioTrack = useCallback(
    (index: number) => {
      const tracks = media.tracks?.audio;
      const video = videoRef.current;
      const track = tracks?.[index];
      if (!tracks || !video || !track) return;
      if (usingMpv) {
        const id = mpvPlayer.video.audioId(index);
        if (id !== null) void mpv.set("aid", id).catch((error) => useUi.getState().toast(describeError(error), "error"));
        setAudioTrack(index);
        return;
      }
      if (conversionRef.current !== null) {
        setAudioTrack(index);
        setConversionStart(filmTime());
        return;
      }

      const builtIn = tracks.filter(playsUnconverted);
      const own = video.audioTracks;
      const position = builtIn.indexOf(track);
      const listsMatch = own !== undefined && own.length === builtIn.length;
      if (position >= 0 && listsMatch) {
        for (let i = 0; i < own.length; i++) own[i].enabled = i === position;
        video.currentTime = video.currentTime;
        setConvertedTrack(null);
      } else if (position === 0 && !listsMatch) {
        setConvertedTrack(null);
      } else {
        setConvertedTrack(index);
      }
      setAudioTrack(index);
    },
    [media.tracks, usingMpv, mpvPlayer.video],
  );

  const [probeWaitOver, setProbeWaitOver] = useState(false);
  useEffect(() => {
    setProbeWaitOver(false);
    if (!metadataReady) return;
    const timer = setTimeout(() => setProbeWaitOver(true), probeWaitMs);
    return () => clearTimeout(timer);
  }, [metadataReady, source?.id]);
  const probeSettled = !usingMpv || probed !== null || htmlMedia.ffmpegInstalled === false || probeWaitOver;

  useEffect(() => {
    const tracks = media.tracks?.audio;
    if (!tracks || tracks.length === 0 || !metadataReady || pickedAudio.current || !probeSettled) return;
    const asked = preferences?.audioLanguage || settings.audioLanguage;
    if (!asked && !originalSettled) return;
    const wanted = asked || originalLanguage;
    const isOriginalTrack = (track: AudioTrackInfo) => track.isOriginal || originalTrackTitle.test(track.title);
    const pickFrom = (list: AudioTrackInfo[]) =>
      list.find((track) => preferences?.audioTitle && track.title === preferences.audioTitle) ??
      (asked ? undefined : list.find(isOriginalTrack)) ??
      list.find((track) => (usingMpv ? track.isDefault : playsUnconverted(track))) ??
      list[0];
    const inLanguage = wanted ? tracks.filter((track) => languageCode(track.language) === wanted) : [];
    const choice =
      pickFrom(inLanguage.filter((track) => !commentaryTrackTitle.test(track.title))) ??
      pickFrom(inLanguage) ??
      (asked ? undefined : tracks.find(isOriginalTrack)) ??
      tracks.find((track) => track.isDefault) ??
      tracks[0];
    pickedAudio.current = true;
    if (choice.index !== audioTrack) applyAudioTrack(choice.index);
    releaseStart();
  }, [media.tracks, metadataReady, originalLanguage, originalSettled, probeSettled, applyAudioTrack]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseAudioTrack = (track: AudioTrackInfo) => {
    pickedAudio.current = true;
    applyAudioTrack(track.index);
    setMenu(null);
    const chosen = languageCode(track.language);
    if (chosen) rememberForTitle(session.title, { audioLanguage: chosen, audioTitle: track.title });
  };

  useConvertedAudio(videoRef, source ?? null, heardConverted, volume, muted, audioDelay);

  useEffect(() => {
    if (!metadataReady || subtitlesDecided.current) return;
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

  useEffect(() => {
    if (usingMpv || !playing || muted) return;
    const timer = setTimeout(() => {
      const video = videoRef.current;
      if (video && video.currentTime > 2 && video.webkitAudioDecodedByteCount === 0) setSilentAudio(true);
    }, silentAudioCheckDelayMs);
    return () => clearTimeout(timer);
  }, [playing, muted, url]);


  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      playNext();
      return;
    }
    const timer = setTimeout(() => setCountdown((value) => (value === null ? null : value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [countdown, playNext]);

  const dropCheck = useRef({ last: -1, bad: 0 });
  useEffect(() => {
    dropCheck.current = { last: -1, bad: 0 };
  }, [source?.id, sessionQuality]);

  useEffect(() => {
    if (!usingMpv || !settings.autoSimplify || !playing || buffering || sessionQuality === "fast") return;
    const timer = setInterval(() => {
      void mpv
        .stats()
        .then((stats) => {
          const dropped = Number(stats["frame-drop-count"] ?? 0) + Number(stats["decoder-frame-drop-count"] ?? 0);
          const check = dropCheck.current;
          check.bad = check.last >= 0 && dropped - check.last > droppedFramesPerCheck ? check.bad + 1 : 0;
          check.last = dropped;
          if (check.bad < badChecksToSimplify) return;
          check.bad = 0;
          const next = qualitySteps[Math.min(qualitySteps.length - 1, qualitySteps.indexOf(sessionQuality) + 1)];
          setSessionQuality(next);
          toast(t("player.quality.simplified"), "info", {
            label: t("player.quality.restore"),
            run: () => setSessionQuality(useSettings.getState().videoQuality),
          });
        })
        .catch(() => undefined);
    }, healthCheckMs);
    return () => clearInterval(timer);
  }, [usingMpv, settings.autoSimplify, playing, buffering, sessionQuality]); // eslint-disable-line react-hooks/exhaustive-deps

  const stalls = useRef<number[]>([]);
  useEffect(() => {
    stalls.current = [];
    setSlowSource(false);
    setSlowDismissed(false);
  }, [source?.id]);

  useEffect(() => {
    if (!buffering || !metadataReady || !source || playedSeconds.current < 5) return;
    if (fileProgress(useTorrents.getState().byHash[source.infoHash], source.fileIndex) >= 1) return;
    const afterSeek = Date.now() - lastSeekAt.current < 4000;
    const note = () => {
      const now = Date.now();
      stalls.current = [...stalls.current.filter((at) => now - at < stallWindowMs), now];
      if (stalls.current.length >= stallsToSuggest) setSlowSource(true);
    };
    const short = setTimeout(() => {
      if (!afterSeek) note();
    }, 2500);
    const long = setTimeout(() => setSlowSource(true), stallLongSeconds * 1000);
    return () => {
      clearTimeout(short);
      clearTimeout(long);
    };
  }, [buffering, metadataReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const sourceTarget = (season: number) => {
    const pageTarget = useUi.getState().pageTarget;
    if (pageTarget && pageTarget.title.id === session.title.id && pageTarget.title.type === session.title.type) {
      return { ...pageTarget, defaultSeason: season };
    }
    const details = titleDetails.data;
    return {
      title: session.title,
      originalTitle: details?.originalTitle,
      originalLanguage: details?.language,
      seasons: details?.seasons ?? [],
      defaultSeason: season,
    };
  };

  const playEpisode = (episode: Episode) => {
    if (episode.season === session.season && episode.episode === session.episode) return;
    setEpisodesShown(false);
    saveProgress();
    play({
      title: session.title,
      unitKey: unitKey("tv", session.title.id, episode.season, episode.episode),
      season: episode.season,
      episode: episode.episode,
      episodeName: episode.name,
    });
  };

  const findEpisode = (episode: Episode) => {
    saveProgress();
    closePlayer();
    useUi.getState().openAddSource({ target: sourceTarget(episode.season) });
  };

  const findLighter = (filter: string) => {
    const pageTarget = useUi.getState().pageTarget;
    const target =
      pageTarget && pageTarget.title.id === session.title.id && pageTarget.title.type === session.title.type
        ? pageTarget
        : { title: session.title, seasons: [], defaultSeason: session.season ?? 1 };
    const prefs = useSettings.getState().trackerPrefs;
    useSettings.getState().patch({ trackerPrefs: { ...prefs, resolutions: [filter] } });
    saveProgress();
    closePlayer();
    useUi.getState().openAddSource({ target });
  };

  useMediaSession({
    native: usingMpv || isLinux,
    title: session.title.title,
    subtitle:
      session.episode !== undefined
        ? `${t("common.seasonEpisode", { season: session.season ?? "", episode: session.episode })}${session.episodeName ? ` — ${session.episodeName}` : ""}`
        : session.title.year,
    cover: imageUrl(titleDetails.data?.seasons.find((item) => item.seasonNumber === session.season)?.poster ?? session.title.poster, "w500"),
    duration,
    playing,
    position: filmTime,
    controls: {
      play: () => void videoRef.current?.play()?.catch(() => undefined),
      pause: () => videoRef.current?.pause(),
      toggle: togglePlay,
      next: nextEpisode ? playNext : null,
      seekBy,
      seekTo,
      stop: () => videoRef.current?.pause(),
    },
  });

  const onEnded = () => {
    if (endedRef.current) return;
    endedRef.current = true;
    saveProgress();
    setEnded(true);
    if (nextEpisode && settings.autoNextEpisode) setCountdown(nextEpisodeCountdownSeconds);
  };
  const endedRef = useRef(false);
  endedRef.current = ended;
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  useEffect(() => {
    if (ended || failed || duration < upNextMinDurationSeconds || current < duration - stuckEndSeconds) return;
    const timer = setTimeout(() => {
      if (filmTime() >= filmLength() - stuckEndSeconds) onEndedRef.current();
    }, stuckEndWaitMs);
    return () => clearTimeout(timer);
  }, [current, duration, ended, failed, filmTime, filmLength]);

  const handlers: MediaHandlers = {
    onPlay: () => setPlaying(true),
    onPause: () => {
      setPlaying(false);
      saveProgress();
    },
    onWaiting: () => setBuffering(true),
    onPlaying: () => {
      setBuffering(false);
      setEnded(false);
    },
    onLoadedMetadata: () => {
      const video = videoRef.current;
      if (!video) return;
      video.playbackRate = rate;
      if (conversionRef.current !== null) {
        setDuration(statedLength.current);
      } else {
        setDuration(video.duration);
        if (!usingMpv && resumeAt.current > 0 && resumeAt.current < video.duration - 5) video.currentTime = resumeAt.current;
      }
      resumeAt.current = 0;
      if (!usingMpv) setAudio(readAudioOptions(video));
      setMetadataReady(true);
      setResolution(video.videoWidth > 0 ? `${video.videoWidth}×${video.videoHeight}` : "");
      const detected = qualityFromSize(video.videoWidth, video.videoHeight);
      if (detected && source && !source.quality) useLibrary.getState().setSourceQuality(session.unitKey, source.id, detected);
    },
    onDurationChange: () => {
      const video = videoRef.current;
      if (video && conversionRef.current === null) setDuration(video.duration);
    },
    onTimeUpdate: () => {
      const time = filmTime();
      const previous = lastPlayedAt.current;
      lastPlayedAt.current = time;
      if (previous !== null && playing && !buffering) {
        const step = time - previous;
        if (step > 0 && step <= naturalStepSeconds * Math.max(1, rate)) playedSeconds.current += step;
      }
      if (Math.abs(time - shownTime.current) < clockStepSeconds) return;
      shownTime.current = time;
      setCurrent(time);
    },
    onProgress: () => {
      if (usingMpv) {
        setBuffered(mpvPlayer.video.bufferedRanges.map((range) => ({ start: range.start, end: range.end })));
        return;
      }
      const ranges = videoRef.current?.buffered;
      if (!ranges) return;
      const offset = conversionRef.current ?? 0;
      setBuffered(Array.from({ length: ranges.length }, (_, index) => ({ start: offset + ranges.start(index), end: offset + ranges.end(index) })));
    },
    onSeeked: () => saveProgress(),
    onEnded: () => onEnded(),
    onError: () => {
      if (!usingMpv && conversionRef.current === null && media.tracks) {
        startConversion();
        return;
      }
      setFailed(true);
      setBuffering(false);
    },
  };
  mpvPlayer.video.handlers = handlers;

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
  const bufferedAhead = downloaded >= 1 ? [] : buffered.filter((range) => range.start <= current + 1 && range.end > current);
  const subtitle =
    session.episode !== undefined
      ? `${t("common.seasonEpisode", { season: session.season ?? "", episode: session.episode })}${session.episodeName ? ` — ${session.episodeName}` : ""}`
      : session.title.year;
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const subtitleStyle = {
    fontSize: `${settings.subtitleScale}em`,
    fontFamily: subtitleFonts[settings.subtitleFont].css,
    color: subtitleColors[settings.subtitleColor],
    bottom: `calc(var(--subtitle-bottom) + ${settings.subtitlePosition}%)`,
  } as React.CSSProperties;
  const pictureStyle: React.CSSProperties = {
    transform: zoom !== 1 ? `scale(${zoom})` : undefined,
    ...(aspect !== "auto" ? { objectFit: "fill", aspectRatio: aspect.replace(":", " / "), width: "auto", height: "100%", maxWidth: "100%", margin: "auto" } : {}),
  };
  const currentRank = qualityRank(source.quality);
  const lighterSources = sources.filter((item) => item.id !== source.id && qualityRank(item.quality) > 0 && qualityRank(item.quality) < currentRank);
  const lighterFilter = currentRank >= 2000 ? "1080" : currentRank >= 1000 ? "720" : null;
  const slowShown = slowSource && !slowDismissed && downloaded < 1 && !failed;

  return (
    <div
      ref={rootRef}
      className={`player ${controlsShown ? "" : "is-idle"} ${mini ? "is-mini" : ""}`}
      onMouseMove={wakeControls}
      onMouseDown={wakeControls}
    >
      {usingMpv && <div className="player__surface" onClick={togglePlay} onDoubleClick={toggleFullscreen} />}

      {url && mpvChoice.mode === "unavailable" && (
        <video
          ref={videoRef}
          key={url}
          src={url}
          crossOrigin="anonymous"
          style={pictureStyle}
          autoPlay
          onClick={togglePlay}
          onDoubleClick={toggleFullscreen}
          onPlay={handlers.onPlay}
          onPause={handlers.onPause}
          onWaiting={handlers.onWaiting}
          onPlaying={handlers.onPlaying}
          onCanPlay={() => setBuffering(false)}
          onLoadedMetadata={handlers.onLoadedMetadata}
          onLoadedData={(event) => {
            // The converted HLS playlist grows while it plays, so WebKit treats it as live and starts at its newest segment.
            if (conversionRef.current !== null && event.currentTarget.currentTime > 1) event.currentTarget.currentTime = 0;
          }}
          onDurationChange={handlers.onDurationChange}
          onTimeUpdate={handlers.onTimeUpdate}
          onProgress={handlers.onProgress}
          onSeeked={handlers.onSeeked}
          onEnded={handlers.onEnded}
          onError={handlers.onError}
        />
      )}

      {subtitleText && (
        <div className={`player__subtitle player__subtitle--${settings.subtitleBackground}`} style={subtitleStyle}>
          <span>{subtitleText}</span>
        </div>
      )}
      {secondaryText && (
        <div
          className={`player__subtitle player__subtitle--secondary player__subtitle--${settings.subtitleBackground}`}
          style={{ fontSize: `${settings.subtitleScale * 0.85}em`, fontFamily: subtitleFonts[settings.subtitleFont].css }}
        >
          <span>{secondaryText}</span>
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
              {usingMpv && (
                <button className="button" onClick={switchToBuiltIn}>
                  {t("player.mpv.useBuiltIn")}
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
            {nextCandidate && (
              <p>
                {t("player.upNext.title")}: {t("common.seasonEpisode", { season: nextCandidate.season, episode: nextCandidate.episode })} · {nextCandidate.name}
              </p>
            )}
            <div className="player__message-actions">
              {nextEpisode ? (
                <button className="button button--primary" onClick={playNext}>
                  <SkipForward size={16} />
                  {t("player.next")}
                </button>
              ) : nextCandidate ? (
                <button className="button button--primary" onClick={() => findEpisode(nextCandidate)}>
                  {t("player.episodes.findNext")}
                </button>
              ) : null}
              <button className="button" onClick={() => seekTo(0)}>
                <RotateCcw size={16} />
                {t("player.restart")}
              </button>
              <button className={`button ${nextCandidate ? "" : "button--primary"}`} onClick={close}>
                {t("common.close")}
              </button>
            </div>
          </div>
        ) : mpvChoice.mode === "installing" ? (
          <div className="player__message">
            <LoaderCircle size={36} className="spin" />
            <strong>{t("player.mpv.installing", { percent: Math.round(mpvChoice.progress * 100) })}</strong>
            <div className="player__message-actions">
              <button className="button" onClick={switchToBuiltIn}>
                {t("player.mpv.skip")}
              </button>
            </div>
          </div>
        ) : buffering || startHeld ? (
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
                        {item.hashMatch && <em className="is-match">{t("player.subtitles.online.hashMatch")}</em>}
                        {!item.hashMatch && item.sameRelease && <em className="is-match">{t("player.subtitles.online.sameRelease")}</em>}
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

      {statsShown && (
        <StatsPanel
          usingMpv={usingMpv}
          videoRef={videoRef}
          videoCodec={media.tracks?.videoCodec ?? ""}
          torrent={torrent}
          fileProgress={downloaded}
          fileSize={source.size}
          onClose={() => setStatsShown(false)}
        />
      )}

      {slowShown && (
        <div className="player__notice player__notice--slow">
          <TriangleAlert size={16} />
          <span>{t("player.slow.text")}</span>
          {lighterSources.slice(0, 2).map((item) => (
            <button key={item.id} className="button button--small button--primary" onClick={() => switchSource(item)}>
              {t("player.slow.switch", { quality: item.quality })}
            </button>
          ))}
          {lighterSources.length === 0 && lighterFilter && (
            <button className="button button--small button--primary" onClick={() => findLighter(lighterFilter)}>
              {t("player.slow.find", { quality: lighterFilter === "1080" ? "1080p" : "720p" })}
            </button>
          )}
          <button className="button button--small" onClick={() => setSlowDismissed(true)}>
            {t("player.hide")}
          </button>
        </div>
      )}

      {hotkeysShown && (
        <div className="player__panel player__hotkeys" role="dialog" aria-label={t("settings.hotkeys")}>
          <div className="player__hotkeys-head">
            <strong>{t("settings.hotkeys")}</strong>
            <button className="icon-button" aria-label={t("common.close")} onClick={() => setHotkeysShown(false)}>
              <X size={16} />
            </button>
          </div>
          <HotkeyList />
        </div>
      )}

      {upNextVisible && nextEpisode && (
        <div className="player__up-next">
          {nextEpisode.still && !settings.spoilerStills && <img src={imageUrl(nextEpisode.still, "w300") ?? undefined} alt="" draggable={false} />}
          <div className="player__up-next-body">
            <span>{t("player.upNext.title")}</span>
            <strong>
              {t("common.seasonEpisode", { season: nextEpisode.season, episode: nextEpisode.episode })} · {nextEpisode.name}
            </strong>
            <div className="player__up-next-actions">
              <button className="button button--primary" onClick={playNext}>
                <SkipForward size={16} />
                {upNextLeft !== null ? t("player.upNext.in", { seconds: upNextLeft }) : t("player.next.watchNow")}
              </button>
              <button className="button" onClick={() => setUpNextDismissed(true)}>
                {t("player.upNext.stay")}
              </button>
            </div>
          </div>
        </div>
      )}

      {skippable && !failed && !(upNextVisible && skippable.kind === "credits") && (
        <div className="player__skips">
          <button className="player__skip" onClick={() => seekTo(skippable.end)}>
            <SkipForward size={16} />
            {t(skippable.sceneAfter ? "player.skip.toScene" : `player.skip.${skippable.kind}`)}
          </button>
          {skippable.kind === "credits" && skippable.sceneAfter && nextEpisode && (
            <button className="player__skip" onClick={playNext}>
              <SkipForward size={16} />
              {t("player.next")}
            </button>
          )}
        </div>
      )}

      {episodesShown && session.season !== undefined && session.episode !== undefined && (
        <PlayerEpisodes
          titleId={session.title.id}
          seasons={titleDetails.data?.seasons ?? []}
          current={{ season: session.season, episode: session.episode }}
          onPlay={playEpisode}
          onFind={findEpisode}
          onClose={() => setEpisodesShown(false)}
        />
      )}

      <div className="player__bottom">
        <SeekBar
          current={current}
          duration={duration}
          buffered={bufferedAhead}
          pieces={pieces}
          chapters={chapters}
          advancing={playing && !buffering && !ended}
          rate={rate}
          thumbnail={thumbnail}
          onSeek={seekTo}
        />
        <div className="player__controls">
          <button
            className="player__button player__button--main"
            aria-label={playing ? t("player.pause") : t("player.play")}
            title={`${playing ? t("player.pause") : t("player.play")} (${t("hotkeys.key.space")})`}
            onClick={togglePlay}
          >
            {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
          </button>
          <button className="player__button" aria-label={t("player.seekBack")} onClick={() => seekBy(-seekStepSeconds)}>
            <RotateCcw size={19} />
          </button>
          <button className="player__button" aria-label={t("player.seekForward")} onClick={() => seekBy(seekStepSeconds)}>
            <RotateCw size={19} />
          </button>
          {session.episode !== undefined && (
            <button
              className="player__button"
              aria-label={t("player.previous")}
              title={previousEpisode ? `${t("player.previous.named", { name: previousEpisode.name })} (B)` : t("player.previous.none")}
              disabled={!previousEpisode}
              onClick={() => previousEpisode && playEpisode(previousEpisode)}
            >
              <SkipBack size={19} />
            </button>
          )}
          {session.episode !== undefined && (
            <button
              className="player__button"
              aria-label={t("player.next")}
              title={nextEpisode ? `${t("player.next.named", { name: nextEpisode.name })} (N)` : t("player.next.none")}
              disabled={!nextEpisode}
              onClick={playNext}
            >
              <SkipForward size={19} />
            </button>
          )}
          {session.episode !== undefined && (
            <button
              className={`player__button ${episodesShown ? "is-on" : ""}`}
              aria-label={t("player.episodes")}
              title={`${t("player.episodes")} (E)`}
              onClick={() => setEpisodesShown((value) => !value)}
            >
              <ListVideo size={19} />
            </button>
          )}
          <div className="player__volume">
            <button className="player__button" aria-label={t("player.sound")} title={`${t("player.sound")} (M)`} onClick={() => setMuted((value) => !value)}>
              <VolumeIcon size={19} />
            </button>
            <input
              type="range"
              min={0}
              max={volumeMax}
              step={0.01}
              value={muted ? 0 : volume}
              aria-label={t("player.volume")}
              title={`${Math.round((muted ? 0 : volume) * 100)}%`}
              className={volume > 1 && !muted ? "is-boosted" : ""}
              style={{ "--fill": `${((muted ? 0 : volume) / volumeMax) * 100}%`, "--unity": `${(1 / volumeMax) * 100}%` } as React.CSSProperties}
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

          <button className={`player__button ${cues.length > 0 || (usingMpv && subtitleKey !== null) ? "is-on" : ""}`} aria-label={t("common.subtitles")} title={`${t("common.subtitles")} (C)`} onClick={() => setMenu(menu === "subtitles" ? null : "subtitles")}>
            <Captions size={20} />
          </button>
          <button
            className={`player__button ${settings.audioMode !== "off" ? "is-on" : ""}`}
            aria-label={t("player.audioTrack")}
            title={`${t("player.audioTrack")} (A)`}
            onClick={() => setMenu(menu === "audio" ? null : "audio")}
          >
            <AudioLines size={19} />
          </button>
          <button className={`player__button ${zoom !== 1 || aspect !== "auto" ? "is-on" : ""}`} aria-label={t("player.picture")} title={t("player.picture")} onClick={() => setMenu(menu === "picture" ? null : "picture")}>
            <Frame size={19} />
          </button>
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
          <button
            className="player__button"
            aria-label={fullscreen ? t("player.fullscreen.exit") : t("player.fullscreen.enter")}
            title={`${fullscreen ? t("player.fullscreen.exit") : t("player.fullscreen.enter")} (F)`}
            onClick={toggleFullscreen}
          >
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
            <h3>{t("player.audio.mode")}</h3>
            <div className="player__menu-row player__menu-row--wrap">
              {(["off", "night", "level", "dialogue"] as const).map((mode) => (
                <button
                  key={mode}
                  className={`chip ${settings.audioMode === mode ? "is-active" : ""}`}
                  title={t(`player.audio.mode.${mode}.note`)}
                  onClick={() => settings.patch({ audioMode: mode })}
                >
                  {t(`player.audio.mode.${mode}`)}
                </button>
              ))}
            </div>
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
        {menu === "picture" && (
          <div className="player__menu">
            <h3>{t("player.picture.zoom")}</h3>
            <div className="player__menu-row player__delay">
              <button className="chip" aria-label={t("player.picture.zoomOut")} title={`${t("player.picture.zoomOut")} (−)`} disabled={zoom <= zoomMin} onClick={() => changeZoom(-zoomStep)}>
                <ZoomOut size={14} />
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button className="chip" aria-label={t("player.picture.zoomIn")} title={`${t("player.picture.zoomIn")} (+)`} disabled={zoom >= zoomMax} onClick={() => changeZoom(zoomStep)}>
                <ZoomIn size={14} />
              </button>
            </div>
            <h3>{t("player.picture.aspect")}</h3>
            <div className="player__menu-row player__menu-row--wrap">
              {aspectChoices.map((choice) => (
                <button key={choice} className={`chip ${aspect === choice ? "is-active" : ""}`} onClick={() => setAspect(choice)}>
                  {choice === "auto" ? t("player.picture.aspectOriginal") : choice}
                </button>
              ))}
            </div>
            {isDesktop && (
              <button className="player__menu-item" onClick={() => void takeScreenshot()}>
                <Camera size={15} />
                <span>{t("player.screenshot")}</span>
                <small>P</small>
              </button>
            )}
            <button className="player__menu-item" onClick={() => setStatsShown((value) => !value)}>
              {statsShown ? <Check size={15} /> : <i />}
              <span>{t("player.stats.title")}</span>
              <small>D</small>
            </button>
            {chapters.length > 1 && (
              <div className="player__menu-row">
                <button className="chip" onClick={() => jumpChapter(-1)}>
                  {t("player.chapter.previous")}
                </button>
                <button className="chip" onClick={() => jumpChapter(1)}>
                  {t("player.chapter.next")}
                </button>
              </div>
            )}
            <button className="player__menu-item player__menu-item--reset" disabled={zoom === 1 && aspect === "auto" && rate === 1} onClick={resetPicture}>
              <RotateCcw size={15} />
              <span>{t("player.picture.reset")}</span>
              <small>R</small>
            </button>
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
            {((media.tracks?.subtitles ?? []).some((track) => track.isText) || (!usingMpv && subtitleOptions.length > 0)) && (
              <>
                <h3>{t("player.subtitles.secondary")}</h3>
                <button className="player__menu-item" onClick={clearSecondary}>
                  {secondary === null ? <Check size={15} /> : <i />}
                  <span>{t("player.subtitles.off")}</span>
                </button>
                {(media.tracks?.subtitles ?? [])
                  .filter((track) => track.isText)
                  .map((track) => (
                    <button key={`second:${track.index}`} className="player__menu-item" onClick={() => chooseSecondaryEmbedded(track)}>
                      {secondary?.key === `embedded:${track.index}` ? <Check size={15} /> : <i />}
                      <span>{embeddedSubtitleLabel(track, locale)}</span>
                      <small>{track.title}</small>
                    </button>
                  ))}
                {!usingMpv &&
                  subtitleOptions.map((option) => (
                    <button key={`second:${option.key}`} className="player__menu-item" onClick={() => void chooseSecondaryFile(option)}>
                      {secondary?.key === option.key ? <Check size={15} /> : <i />}
                      <span>{option.label}</span>
                      <small>{option.detail}</small>
                    </button>
                  ))}
              </>
            )}
            <h3>{t("player.subtitles.look")}</h3>
            <div className="player__menu-row player__menu-row--wrap">
              {(["outline", "shadow", "box"] as const).map((background) => (
                <button
                  key={background}
                  className={`chip ${settings.subtitleBackground === background ? "is-active" : ""}`}
                  onClick={() => settings.patch({ subtitleBackground: background })}
                >
                  {t(`player.subtitles.background.${background}`)}
                </button>
              ))}
              {(Object.keys(subtitleColors) as SubtitleColor[]).map((color) => (
                <button
                  key={color}
                  className={`chip chip--swatch ${settings.subtitleColor === color ? "is-active" : ""}`}
                  aria-label={t(`player.subtitles.color.${color}`)}
                  title={t(`player.subtitles.color.${color}`)}
                  style={{ "--swatch": subtitleColors[color] } as React.CSSProperties}
                  onClick={() => settings.patch({ subtitleColor: color })}
                />
              ))}
            </div>
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
