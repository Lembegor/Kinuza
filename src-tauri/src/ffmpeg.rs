//! FFmpeg, fetched the first time it is needed. The built-in player cannot decode some audio
//! (AC-3, E-AC-3, DTS, TrueHD); FFmpeg converts such a track to AAC on the fly, and the player
//! plays it next to the picture. Nothing is converted ahead of time or written to disk.

use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Duration,
};

use anyhow::{anyhow, bail, Context};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::{io::AsyncWriteExt, process::Command, sync::Mutex};

use crate::AppState;

/// The LGPL build with shared libraries: half the size of the static one. "master-latest" is the
/// one name in these releases that does not change from month to month.
const ARCHIVE_NAME: &str = "ffmpeg-master-latest-win64-lgpl-shared.zip";
const RELEASE_URL: &str = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";
const CHECKSUMS_NAME: &str = "checksums.sha256";
const FOLDER_NAME: &str = "ffmpeg";
const BINARIES_FOLDER_NAME: &str = "bin";
const EXECUTABLE_NAME: &str = "ffmpeg.exe";
/// Shown as the download size before the real one is known.
const APPROXIMATE_ARCHIVE_BYTES: u64 = 82 * 1024 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(40);
/// Windows: do not flash a console window for a child process.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct FfmpegState {
    /// Held for the whole installation, so two requests cannot download at once.
    install: Mutex<()>,
    installing: AtomicBool,
    downloaded_bytes: AtomicU64,
    total_bytes: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    installed: bool,
    installing: bool,
    downloaded_bytes: u64,
    total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    /// Position among the file's audio tracks, from zero; what the audio stream is asked for.
    index: usize,
    /// ISO 639 code as the file states it ("rus", "eng"); empty when it does not.
    language: String,
    codec: String,
    /// Channel layout as FFmpeg names it: "stereo", "5.1(side)".
    channels: String,
    title: String,
    is_default: bool,
    /// The file marks the track as the film's original language.
    is_original: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleTrack {
    /// Position among the file's subtitle tracks, from zero.
    index: usize,
    language: String,
    codec: String,
    title: String,
    is_default: bool,
    is_forced: bool,
    /// Text subtitles can be shown; picture-based ones (Blu-ray PGS, DVD) cannot be converted to text.
    is_text: bool,
}

/// A named stretch of the film marked in the file: "Opening", "Chapter 3", "End Credits".
#[derive(Serialize)]
pub struct Chapter {
    /// Seconds from the start of the film.
    start: f64,
    end: f64,
    title: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaTracks {
    audio: Vec<AudioTrack>,
    subtitles: Vec<SubtitleTrack>,
    chapters: Vec<Chapter>,
    /// Running time in seconds; 0 when the file does not state it.
    duration: f64,
    /// Codec of the picture, as FFmpeg names it: "h264", "hevc", "mpeg4".
    video_codec: String,
}

/// H.264 encoders in the order they are tried: the graphics card's own first (fast, no load on
/// the processor), then Windows' built-in one, then a software one that always works.
const VIDEO_ENCODERS: &[(&str, &[&str])] = &[
    ("h264_nvenc", &["-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0"]),
    ("h264_qsv", &["-global_quality", "23"]),
    ("h264_amf", &["-quality", "balanced", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24"]),
    ("h264_mf", &["-b:v", "8M"]),
    ("libopenh264", &["-b:v", "6M"]),
];

static VIDEO_ENCODER: tokio::sync::OnceCell<Option<usize>> = tokio::sync::OnceCell::const_new();

/// The first encoder that actually works here, with its quality settings. Listing an encoder
/// does not mean the hardware for it is present, so each is tried on a tiny blank picture.
pub async fn video_encoder(executable: &Path) -> Option<(&'static str, &'static [&'static str])> {
    let index = VIDEO_ENCODER
        .get_or_init(|| async {
            for (index, (name, _)) in VIDEO_ENCODERS.iter().enumerate() {
                let probe = command(executable)
                    .args(["-loglevel", "error", "-f", "lavfi", "-i", "color=size=256x144:rate=5", "-frames:v", "3"])
                    .args(["-pix_fmt", "yuv420p", "-c:v", name, "-f", "null", "-"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .await;
                if probe.is_ok_and(|status| status.success()) {
                    return Some(index);
                }
            }
            None
        })
        .await;
    index.map(|index| VIDEO_ENCODERS[index])
}

/// `Duration: 02:28:07.97, start: ...` gives the seconds.
fn duration_seconds(line: &str) -> Option<f64> {
    let clock = line.strip_prefix("Duration: ")?.split(',').next()?;
    let mut parts = clock.trim().split(':');
    let (hours, minutes, seconds) = (parts.next()?, parts.next()?, parts.next()?);
    Some(hours.parse::<f64>().ok()? * 3600.0 + minutes.parse::<f64>().ok()? * 60.0 + seconds.parse::<f64>().ok()?)
}

/// Subtitle formats FFmpeg can turn into plain text cues.
const TEXT_SUBTITLE_CODECS: &[&str] = &["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"];

/// Where a usable FFmpeg is: the copy this app installed, else one on PATH.
pub fn executable(data_dir: &Path) -> Option<PathBuf> {
    let installed = data_dir.join(FOLDER_NAME).join(BINARIES_FOLDER_NAME).join(EXECUTABLE_NAME);
    if installed.is_file() {
        return Some(installed);
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|folder| folder.join(EXECUTABLE_NAME))
            .find(|candidate| candidate.is_file())
    })
}

/// A command for FFmpeg that reads nothing from the terminal and opens no window.
pub fn command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .args(["-hide_banner", "-nostdin"])
        .stdin(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[tauri::command]
pub fn ffmpeg_status(app: State<'_, AppState>, ffmpeg: State<'_, FfmpegState>) -> FfmpegStatus {
    let total = ffmpeg.total_bytes.load(Ordering::Relaxed);
    FfmpegStatus {
        installed: executable(&app.data_dir).is_some(),
        installing: ffmpeg.installing.load(Ordering::Relaxed),
        downloaded_bytes: ffmpeg.downloaded_bytes.load(Ordering::Relaxed),
        total_bytes: if total > 0 { total } else { APPROXIMATE_ARCHIVE_BYTES },
    }
}

/// Downloads and unpacks FFmpeg. Resolves once it is ready to use; safe to call when it already is.
#[tauri::command]
pub async fn ffmpeg_install(app: State<'_, AppState>, ffmpeg: State<'_, FfmpegState>) -> Result<(), String> {
    let _installing = ffmpeg.install.lock().await;
    if executable(&app.data_dir).is_some() {
        return Ok(());
    }
    ffmpeg.downloaded_bytes.store(0, Ordering::Relaxed);
    ffmpeg.total_bytes.store(0, Ordering::Relaxed);
    ffmpeg.installing.store(true, Ordering::Relaxed);
    let result = install(&app.data_dir.join(FOLDER_NAME), &ffmpeg).await;
    ffmpeg.installing.store(false, Ordering::Relaxed);
    result.map_err(|error| {
        eprintln!("ffmpeg: install failed: {error:#}");
        "ffmpeg_install_failed".to_owned()
    })
}

async fn install(folder: &Path, progress: &FfmpegState) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(folder).await?;
    let client = reqwest::Client::new();

    let checksums = client
        .get(format!("{RELEASE_URL}/{CHECKSUMS_NAME}"))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let expected = checksums
        .lines()
        .find_map(|line| {
            let (hash, name) = line.split_once(char::is_whitespace)?;
            (name.trim().trim_start_matches('*') == ARCHIVE_NAME).then(|| hash.to_ascii_lowercase())
        })
        .ok_or_else(|| anyhow!("the release lists no checksum for {ARCHIVE_NAME}"))?;

    let archive = folder.join("download.tmp");
    let mut response = client.get(format!("{RELEASE_URL}/{ARCHIVE_NAME}")).send().await?.error_for_status()?;
    progress.total_bytes.store(response.content_length().unwrap_or(0), Ordering::Relaxed);

    let mut file = tokio::fs::File::create(&archive).await?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = response.chunk().await? {
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        progress.downloaded_bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
    }
    file.flush().await?;
    drop(file);

    let actual = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    if actual != expected {
        let _ = tokio::fs::remove_file(&archive).await;
        bail!("the downloaded archive does not match its published checksum");
    }

    let target = folder.join(BINARIES_FOLDER_NAME);
    let unpacked = {
        let (archive, target) = (archive.clone(), target.clone());
        tauri::async_runtime::spawn_blocking(move || unpack(&archive, &target)).await?
    };
    let _ = tokio::fs::remove_file(&archive).await;
    unpacked?;

    let version = command(&target.join(EXECUTABLE_NAME)).arg("-version").output().await?;
    anyhow::ensure!(version.status.success(), "the unpacked ffmpeg does not run");
    Ok(())
}

/// Takes FFmpeg itself and the libraries it loads out of the archive's `bin` folder; the rest
/// (ffprobe, ffplay, headers, documentation) is not needed.
fn unpack(archive: &Path, target: &Path) -> anyhow::Result<()> {
    let staging = target.with_extension("new");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;

    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?)?;
    let mut found_executable = false;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index)?;
        let Some(path) = entry.enclosed_name() else { continue };
        let in_binaries = path.parent().and_then(Path::file_name).is_some_and(|folder| folder == BINARIES_FOLDER_NAME);
        let Some(name) = path.file_name().map(|name| name.to_string_lossy().into_owned()) else { continue };
        let wanted = name == EXECUTABLE_NAME || name.to_ascii_lowercase().ends_with(".dll");
        if !entry.is_file() || !in_binaries || !wanted {
            continue;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes)?;
        std::fs::File::create(staging.join(&name))?.write_all(&bytes)?;
        found_executable |= name == EXECUTABLE_NAME;
    }
    anyhow::ensure!(found_executable, "the archive has no {EXECUTABLE_NAME}");

    let _ = std::fs::remove_dir_all(target);
    std::fs::rename(&staging, target).context("could not put the unpacked files in place")?;
    Ok(())
}

/// Lists the audio and subtitle tracks of a torrent file. FFmpeg prints them while opening the
/// file, which is all it is asked to do here.
#[tauri::command]
pub async fn media_tracks(app: State<'_, AppState>, info_hash: String, file_index: usize) -> Result<MediaTracks, String> {
    let executable = executable(&app.data_dir).ok_or_else(|| "ffmpeg_missing".to_owned())?;
    let url = format!("{}/stream/{}/{}", app.stream_base_url, info_hash, file_index);
    let probe = command(&executable).args(["-i", &url]).stdout(Stdio::null()).stderr(Stdio::piped()).output();
    let output = tokio::time::timeout(PROBE_TIMEOUT, probe)
        .await
        .map_err(|_| "media_probe_timeout".to_owned())?
        .map_err(|e| e.to_string())?;
    let tracks = parse_tracks(&String::from_utf8_lossy(&output.stderr));
    // No picture and no sound means the file could not be opened (a torrent that is not ready yet,
    // for one), not that it is empty; the caller should ask again rather than believe it.
    if tracks.video_codec.is_empty() && tracks.audio.is_empty() {
        return Err("media_probe_failed".to_owned());
    }
    Ok(tracks)
}

/// The language code in the head of a stream line: `0:1(rus)` gives `rus`.
fn stream_language(head: &str) -> String {
    head.split_once("(")
        .and_then(|(_, rest)| rest.split_once(")"))
        .map(|(code, _)| code.to_owned())
        .unwrap_or_default()
}

/// `Chapter #0:3: start 420.586000, end 601.142000` gives `(420.586, 601.142)`.
fn chapter_span(line: &str) -> Option<(f64, f64)> {
    let (_, times) = line.split_once(": start ")?;
    let (start, end) = times.split_once(", end ")?;
    Some((start.trim().parse().ok()?, end.trim().parse().ok()?))
}

/// Reads lines like `Stream #0:1(rus): Audio: ac3, 48000 Hz, 5.1(side), fltp, 448 kb/s (default)`,
/// `Stream #0:5(rus): Subtitle: subrip (srt) (default)` and `Chapter #0:3: start 420.5, end 601.1`,
/// with the `title : ...` line that may follow each.
fn parse_tracks(report: &str) -> MediaTracks {
    enum Last {
        None,
        Audio,
        Subtitle,
        Chapter,
    }
    let mut tracks = MediaTracks::default();
    let mut last = Last::None;

    for line in report.lines() {
        let line = line.trim();
        if let Some(duration) = duration_seconds(line) {
            tracks.duration = duration;
        } else if let Some((_, description)) = line.strip_prefix("Stream #").and_then(|stream| stream.split_once(": Video: ")) {
            // Cover art is a "video" stream too; the film's picture comes first.
            if tracks.video_codec.is_empty() {
                tracks.video_codec = description.split_whitespace().next().unwrap_or_default().trim_end_matches(',').to_owned();
            }
            last = Last::None;
        } else if line.starts_with("Chapter #") {
            last = Last::None;
            if let Some((start, end)) = chapter_span(line) {
                tracks.chapters.push(Chapter { start, end, title: String::new() });
                last = Last::Chapter;
            }
        } else if let Some(stream) = line.strip_prefix("Stream #") {
            last = Last::None;
            if let Some((head, description)) = stream.split_once(": Audio: ") {
                let mut parts = description.split(", ");
                let codec = parts.next().and_then(|part| part.split_whitespace().next()).unwrap_or_default().to_owned();
                tracks.audio.push(AudioTrack {
                    index: tracks.audio.len(),
                    language: stream_language(head),
                    codec,
                    channels: parts.nth(1).unwrap_or_default().to_owned(),
                    title: String::new(),
                    is_default: description.contains("(default)"),
                    is_original: description.contains("(original)"),
                });
                last = Last::Audio;
            } else if let Some((head, description)) = stream.split_once(": Subtitle: ") {
                let codec = description.split_whitespace().next().unwrap_or_default().trim_end_matches(",").to_owned();
                tracks.subtitles.push(SubtitleTrack {
                    index: tracks.subtitles.len(),
                    language: stream_language(head),
                    is_text: TEXT_SUBTITLE_CODECS.contains(&codec.as_str()),
                    codec,
                    title: String::new(),
                    is_default: description.contains("(default)"),
                    is_forced: description.contains("(forced)"),
                });
                last = Last::Subtitle;
            }
        } else if let Some((key, value)) = line.split_once(":") {
            if key.trim() != "title" {
                continue;
            }
            let title = value.trim().to_owned();
            match last {
                Last::Audio => {
                    if let Some(track) = tracks.audio.last_mut() {
                        track.title = title;
                    }
                }
                Last::Subtitle => {
                    if let Some(track) = tracks.subtitles.last_mut() {
                        track.title = title;
                    }
                }
                Last::Chapter => {
                    if let Some(chapter) = tracks.chapters.last_mut() {
                        chapter.title = title;
                    }
                }
                Last::None => {}
            }
        }
    }
    tracks
}
