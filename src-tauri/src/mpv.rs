#![cfg_attr(not(windows), allow(dead_code, unused_imports, unused_variables))]

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Duration,
};

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc, time::Instant};

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot, Mutex},
};

use crate::{files::FileGrants, AppState};

const DOWNLOAD_BASE: &str = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download";
const PINNED_BUILD: &str = include_str!("../mpv.lock.json");
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const REPLY_WAIT: Duration = Duration::from_secs(5);
const TIME_EVENT_EVERY: Duration = Duration::from_millis(200);
const FOLDER_NAME: &str = "mpv";
const EXECUTABLE_NAME: &str = "mpv.exe";
const APPROXIMATE_ARCHIVE_BYTES: u64 = 33 * 1024 * 1024;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PIPE_WAIT: Duration = Duration::from_secs(8);
const EVENT_NAME: &str = "mpv-event";
const SUBTITLES_FOLDER_NAME: &str = "mpv-subtitles";

const ALLOWED_PROPERTIES: &[&str] = &[
    "volume",
    "mute",
    "speed",
    "pause",
    "start",
    "alang",
    "audio-delay",
    "sub-scale",
    "sub-delay",
    "sid",
    "aid",
    "interpolation",
    "volume-max",
    "sub-font",
    "sub-color",
    "sub-back-color",
    "sub-border-color",
    "sub-border-style",
    "sub-border-size",
    "sub-shadow-offset",
    "sub-pos",
    "sub-visibility",
    "secondary-sid",
    "secondary-sub-visibility",
    "video-zoom",
    "video-pan-x",
    "video-pan-y",
    "video-aspect-override",
    "scale",
    "cscale",
    "dscale",
    "deband",
];

const AUDIO_FILTERS: &[(&str, &str)] = &[
    ("off", ""),
    ("night", "lavfi=[acompressor=threshold=0.05:ratio=6:attack=15:release=300:knee=4:makeup=3,alimiter=limit=0.95:level=false]"),
    ("level", "lavfi=[dynaudnorm=f=250:g=15:p=0.9:m=8:s=0]"),
    ("dialogue", "lavfi=[highpass=f=100,equalizer=f=2600:t=q:w=1.1:g=6,equalizer=f=250:t=q:w=1:g=-3,acompressor=threshold=0.1:ratio=3:attack=10:release=200:makeup=2,alimiter=limit=0.95:level=false]"),
];

const STATS_PROPERTIES: &[&str] = &[
    "video-codec",
    "video-format",
    "width",
    "height",
    "container-fps",
    "estimated-vf-fps",
    "display-fps",
    "video-bitrate",
    "audio-codec-name",
    "audio-bitrate",
    "audio-params/channel-count",
    "audio-params/samplerate",
    "hwdec-current",
    "frame-drop-count",
    "decoder-frame-drop-count",
    "demuxer-cache-duration",
    "video-params/gamma",
    "video-params/primaries",
    "current-vo",
];

const SCREENSHOT_FOLDER_NAME: &str = "Kinuza";
const LOADFILE_FLAGS: &[&str] = &["replace", "append"];

const OBSERVED: &[&str] = &[
    "time-pos",
    "duration",
    "pause",
    "paused-for-cache",
    "seeking",
    "eof-reached",
    "idle-active",
    "demuxer-cache-state",
    "track-list",
    "chapter-list",
    "video-params",
    "vo-configured",
    "volume",
    "mute",
    "speed",
];

#[derive(Default)]
pub struct MpvState {
    install: Mutex<()>,
    installing: AtomicBool,
    downloaded_bytes: AtomicU64,
    total_bytes: AtomicU64,
    player: Mutex<Option<Player>>,
}

type Replies = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

struct Player {
    child: Child,
    commands: mpsc::UnboundedSender<String>,
    replies: Replies,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvStatus {
    installed: bool,
    installing: bool,
    downloaded_bytes: u64,
    total_bytes: u64,
}

pub fn has_bundled(app: &AppHandle) -> bool {
    bundled(app).is_some()
}

fn bundled(app: &AppHandle) -> Option<PathBuf> {
    let path = app.path().resource_dir().ok()?.join(FOLDER_NAME).join(EXECUTABLE_NAME);
    path.is_file().then_some(path)
}

fn downloaded(data_dir: &Path) -> Option<PathBuf> {
    let installed = data_dir.join(FOLDER_NAME).join(EXECUTABLE_NAME);
    installed.is_file().then_some(installed)
}

#[cfg(windows)]
pub fn executable(app: &AppHandle, data_dir: &Path) -> Option<PathBuf> {
    bundled(app).or_else(|| downloaded(data_dir))
}

#[cfg(not(windows))]
pub fn executable(_app: &AppHandle, _data_dir: &Path) -> Option<PathBuf> {
    None
}

#[tauri::command]
pub fn mpv_status(handle: AppHandle, app: State<'_, AppState>, mpv: State<'_, MpvState>) -> MpvStatus {
    let total = mpv.total_bytes.load(Ordering::Relaxed);
    MpvStatus {
        installed: executable(&handle, &app.data_dir).is_some(),
        installing: mpv.installing.load(Ordering::Relaxed),
        downloaded_bytes: mpv.downloaded_bytes.load(Ordering::Relaxed),
        total_bytes: if total > 0 { total } else { APPROXIMATE_ARCHIVE_BYTES },
    }
}

#[tauri::command]
pub async fn mpv_install(handle: AppHandle, app: State<'_, AppState>, mpv: State<'_, MpvState>) -> Result<(), String> {
    if cfg!(not(windows)) {
        return Err("mpv_unsupported".to_owned());
    }
    let _installing = mpv.install.lock().await;
    if executable(&handle, &app.data_dir).is_some() {
        return Ok(());
    }
    mpv.downloaded_bytes.store(0, Ordering::Relaxed);
    mpv.total_bytes.store(0, Ordering::Relaxed);
    mpv.installing.store(true, Ordering::Relaxed);
    let result = install(&app.data_dir.join(FOLDER_NAME), &mpv).await;
    mpv.installing.store(false, Ordering::Relaxed);
    result.map_err(|error| {
        tracing::warn!("mpv: install failed: {error:#}");
        "mpv_install_failed".to_owned()
    })
}

#[derive(Deserialize)]
struct PinnedBuild {
    tag: String,
    asset: String,
    sha256: String,
}

fn pinned_build() -> anyhow::Result<PinnedBuild> {
    serde_json::from_str(PINNED_BUILD).context("src-tauri/mpv.lock.json is not valid")
}

async fn install(folder: &Path, progress: &MpvState) -> anyhow::Result<()> {
    let outcome = tokio::time::timeout(INSTALL_TIMEOUT, download_and_unpack(folder, progress))
        .await
        .unwrap_or_else(|_| Err(anyhow!("the mpv download took longer than {} minutes", INSTALL_TIMEOUT.as_secs() / 60)));
    if outcome.is_err() {
        let _ = tokio::fs::remove_file(folder.with_extension("download.tmp")).await;
        let _ = tokio::fs::remove_dir_all(folder.with_extension("new")).await;
    }
    outcome
}

async fn download_and_unpack(folder: &Path, progress: &MpvState) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(folder.parent().unwrap_or(folder)).await?;
    let build = pinned_build()?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("Kinuza/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()?;
    let url = format!("{DOWNLOAD_BASE}/{}/{}", build.tag, build.asset);

    let archive = folder.with_extension("download.tmp");
    let mut response = client.get(&url).send().await?.error_for_status()?;
    progress.total_bytes.store(response.content_length().unwrap_or(0), Ordering::Relaxed);
    let mut file = tokio::fs::File::create(&archive).await?;
    let mut hasher = Sha256::new();
    let downloaded = async {
        while let Some(chunk) = response.chunk().await? {
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            progress.downloaded_bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed);
        }
        file.flush().await?;
        anyhow::Ok(())
    }
    .await;
    drop(file);
    if let Err(error) = downloaded {
        let _ = tokio::fs::remove_file(&archive).await;
        return Err(error);
    }

    let actual = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    if actual != build.sha256.to_ascii_lowercase() {
        let _ = tokio::fs::remove_file(&archive).await;
        bail!("the downloaded mpv does not match the pinned checksum");
    }

    let unpacked = {
        let (archive, folder) = (archive.clone(), folder.to_path_buf());
        tauri::async_runtime::spawn_blocking(move || unpack(&archive, &folder)).await?
    };
    let _ = tokio::fs::remove_file(&archive).await;
    unpacked?;

    let version = background(Command::new(folder.join(EXECUTABLE_NAME)).arg("--version")).output().await?;
    anyhow::ensure!(version.status.success(), "the unpacked mpv does not run");
    tracing::info!("mpv: installed {}", build.asset);
    Ok(())
}

fn unpack(archive: &Path, target: &Path) -> anyhow::Result<()> {
    let staging = target.with_extension("new");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    sevenz_rust2::decompress_file(archive, &staging).map_err(|error| anyhow!("could not unpack mpv: {error}"))?;
    anyhow::ensure!(staging.join(EXECUTABLE_NAME).is_file(), "the archive has no {EXECUTABLE_NAME}");
    let _ = std::fs::remove_dir_all(target);
    std::fs::rename(&staging, target).context("could not put the unpacked files in place")?;
    Ok(())
}

fn background(command: &mut Command) -> &mut Command {
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn pipe_name() -> String {
    format!(r"\\.\pipe\kinuza-mpv-{}", std::process::id())
}

fn main_window_handle(app: &AppHandle) -> anyhow::Result<isize> {
    let window = app.get_webview_window("main").ok_or_else(|| anyhow!("the main window is gone"))?;
    #[cfg(windows)]
    {
        Ok(window.hwnd()?.0 as isize)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        bail!("embedding mpv is supported on Windows only")
    }
}

fn mpv_arguments(window: isize, pipe: &str) -> Vec<String> {
    [
        format!("--wid={window}"),
        format!("--input-ipc-server={pipe}"),
        "--no-config".into(),
        "--idle=yes".into(),
        "--keep-open=yes".into(),
        "--force-window=no".into(),
        "--osc=no".into(),
        "--osd-level=0".into(),
        "--input-default-bindings=no".into(),
        "--media-controls=no".into(),
        "--input-vo-keyboard=no".into(),
        "--input-cursor=no".into(),
        "--cursor-autohide=no".into(),
        "--terminal=no".into(),
        "--vo=gpu-next".into(),
        "--gpu-api=d3d11".into(),
        "--hwdec=auto-safe".into(),
        "--profile=high-quality".into(),
        "--video-sync=display-resample".into(),
        "--interpolation=no".into(),
        "--audio-channels=auto".into(),
        "--audio-exclusive=no".into(),
        "--sub-auto=no".into(),
        "--audio-file-auto=no".into(),
        "--hr-seek=yes".into(),
        "--volume-max=150".into(),
        "--screenshot-format=png".into(),
        "--screenshot-png-compression=4".into(),
        "--cache=yes".into(),
        "--cache-secs=300".into(),
        "--demuxer-max-bytes=1500MiB".into(),
        "--demuxer-max-back-bytes=150MiB".into(),
        "--demuxer-readahead-secs=300".into(),
        "--cache-pause-initial=yes".into(),
        "--cache-pause-wait=2".into(),
        "--network-timeout=600".into(),
        "--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5".into(),
        "--sub-border-size=2.5".into(),
        "--sub-shadow-offset=1".into(),
        "--sub-margin-y=54".into(),
        "--background-color=#000000".into(),
    ]
    .into_iter()
    .collect()
}

#[cfg(windows)]
async fn open_pipe(name: &str) -> anyhow::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    let deadline = tokio::time::Instant::now() + PIPE_WAIT;
    loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(name) {
            Ok(pipe) => return Ok(pipe),
            Err(error) if tokio::time::Instant::now() < deadline => {
                let _ = error;
                tokio::time::sleep(Duration::from_millis(80)).await;
            }
            Err(error) => return Err(anyhow!("mpv did not open its control pipe: {error}")),
        }
    }
}

#[cfg(not(windows))]
async fn spawn(_app: &AppHandle, _data_dir: &Path) -> anyhow::Result<Player> {
    bail!("embedding mpv is supported on Windows only")
}

#[cfg(windows)]
async fn spawn(app: &AppHandle, data_dir: &Path) -> anyhow::Result<Player> {
    let executable = executable(app, data_dir).ok_or_else(|| anyhow!("mpv_missing"))?;
    let window = main_window_handle(app)?;
    let pipe = pipe_name();
    let mut command = Command::new(&executable);
    command.args(mpv_arguments(window, &pipe));
    background(&mut command);
    let child = crate::children::spawn(&mut command).context("could not start mpv")?;

    let pipe = open_pipe(&pipe).await?;
    let (reader, mut writer) = tokio::io::split(pipe);
    let (commands, mut queue) = mpsc::unbounded_channel::<String>();

    tokio::spawn(async move {
        while let Some(line) = queue.recv().await {
            if writer.write_all(line.as_bytes()).await.is_err() || writer.write_all(b"\n").await.is_err() {
                break;
            }
        }
    });

    let events = app.clone();
    let replies: Replies = Arc::default();
    let waiting = replies.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        let mut last_time = Instant::now() - TIME_EVENT_EVERY;
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            if message.get("event").is_none() {
                let id = message.get("request_id").and_then(Value::as_u64).unwrap_or(0);
                if let Some(reply) = waiting.lock().ok().and_then(|mut waiting| waiting.remove(&id)) {
                    let outcome = match message.get("error").and_then(Value::as_str) {
                        None | Some("success") => Ok(message.get("data").cloned().unwrap_or(Value::Null)),
                        Some(error) => Err(error.to_owned()),
                    };
                    let _ = reply.send(outcome);
                }
                continue;
            }
            if message.get("name").and_then(Value::as_str) == Some("time-pos") {
                if last_time.elapsed() < TIME_EVENT_EVERY {
                    continue;
                }
                last_time = Instant::now();
            }
            match message.get("event").and_then(Value::as_str) {
                Some("end-file") if message.get("reason").and_then(Value::as_str) == Some("error") => {
                    tracing::warn!("mpv: playback failed: {}", message.get("file_error").and_then(|error| error.as_str()).unwrap_or("unknown error"));
                }
                Some("video-reconfig") | Some("file-loaded") => place_below_interface(&events),
                _ => {}
            }
            let _ = events.emit(EVENT_NAME, message);
        }
        if let Ok(mut waiting) = waiting.lock() {
            for (_, reply) in waiting.drain() {
                let _ = reply.send(Err("mpv_gone".to_owned()));
            }
        }
        let _ = events.emit(EVENT_NAME, json!({ "event": "shutdown" }));
    });

    for (id, name) in OBSERVED.iter().enumerate() {
        let _ = commands.send(json!({ "command": ["observe_property", id + 1, name] }).to_string());
    }
    tracing::info!("mpv: started");
    Ok(Player { child, commands, replies })
}

#[cfg(windows)]
fn place_below_interface(app: &AppHandle) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowExW, SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
    let Ok(parent) = main_window_handle(app) else { return };
    let class: Vec<u16> = "mpv".encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let child = FindWindowExW(parent as _, std::ptr::null_mut(), class.as_ptr(), std::ptr::null());
        if !child.is_null() {
            SetWindowPos(child, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

#[cfg(not(windows))]
fn place_below_interface(_app: &AppHandle) {}

async fn send(app: &AppHandle, state: &MpvState, data_dir: &Path, command: Value) -> Result<Value, String> {
    let (commands, replies) = {
        let mut player = state.player.lock().await;
        let alive = match player.as_mut() {
            Some(running) => matches!(running.child.try_wait(), Ok(None)) && !running.commands.is_closed(),
            None => false,
        };
        if !alive {
            *player = Some(spawn(app, data_dir).await.map_err(|error| {
                tracing::warn!("mpv: could not start: {error:#}");
                "mpv_start_failed".to_owned()
            })?);
        }
        let running = player.as_ref().ok_or_else(|| "mpv_start_failed".to_owned())?;
        (running.commands.clone(), running.replies.clone())
    };
    let id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
    let (reply, answer) = oneshot::channel();
    if let Ok(mut waiting) = replies.lock() {
        waiting.insert(id, reply);
    }
    let name = command.get(0).and_then(Value::as_str).unwrap_or("").to_owned();
    if commands.send(json!({ "command": command, "request_id": id }).to_string()).is_err() {
        if let Ok(mut waiting) = replies.lock() {
            waiting.remove(&id);
        }
        return Err("mpv_gone".to_owned());
    }
    match tokio::time::timeout(REPLY_WAIT, answer).await {
        Ok(Ok(Ok(data))) => Ok(data),
        Ok(Ok(Err(error))) => {
            if name != "get_property" {
                tracing::warn!("mpv: {name} failed: {error}");
            }
            Err(format!("mpv_failed:{error}"))
        }
        Ok(Err(_)) => Err("mpv_gone".to_owned()),
        Err(_) => {
            if let Ok(mut waiting) = replies.lock() {
                waiting.remove(&id);
            }
            Err("mpv_timeout".to_owned())
        }
    }
}

fn is_plain(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_))
}

fn allowed_command(command: &[Value], stream_base_url: &str, grants: &FileGrants) -> bool {
    if !command.iter().all(is_plain) {
        return false;
    }
    let text = |index: usize| command.get(index).and_then(Value::as_str);
    match text(0) {
        Some("seek") => command.len() <= 3,
        Some("stop") => command.len() == 1,
        Some("loadfile") => {
            let from_our_server = text(1).is_some_and(|url| url.starts_with(&format!("{stream_base_url}/")));
            let flag_ok = command.len() == 2 || text(2).is_some_and(|flag| LOADFILE_FLAGS.contains(&flag));
            from_our_server && command.len() <= 3 && flag_ok
        }
        Some("sub-add") => command.len() <= 5 && text(1).is_some_and(|path| grants.may_read(Path::new(path))),
        _ => false,
    }
}

#[tauri::command]
pub async fn mpv_command(
    app: AppHandle,
    state: State<'_, AppState>,
    mpv: State<'_, MpvState>,
    grants: State<'_, FileGrants>,
    command: Vec<Value>,
) -> Result<(), String> {
    if !allowed_command(&command, &state.stream_base_url, &grants) {
        tracing::warn!("mpv: refused command {:?}", command.first());
        return Err("mpv_command_refused".to_owned());
    }
    send(&app, &mpv, &state.data_dir, Value::Array(command)).await.map(|_| ())
}

#[tauri::command]
pub async fn mpv_warm(app: AppHandle, state: State<'_, AppState>, mpv: State<'_, MpvState>) -> Result<(), String> {
    if executable(&app, &state.data_dir).is_none() {
        return Ok(());
    }
    send(&app, &mpv, &state.data_dir, json!(["get_property", "idle-active"])).await.map(|_| ())
}

#[tauri::command]
pub async fn mpv_set(app: AppHandle, state: State<'_, AppState>, mpv: State<'_, MpvState>, name: String, value: Value) -> Result<(), String> {
    if !ALLOWED_PROPERTIES.contains(&name.as_str()) || !is_plain(&value) {
        tracing::warn!("mpv: refused to set {name}");
        return Err("mpv_property_refused".to_owned());
    }
    send(&app, &mpv, &state.data_dir, json!(["set_property", name, value])).await.map(|_| ())
}

#[tauri::command]
pub async fn mpv_add_subtitle_text(
    app: AppHandle,
    state: State<'_, AppState>,
    mpv: State<'_, MpvState>,
    text: String,
    title: String,
) -> Result<(), String> {
    let folder = state.data_dir.join(SUBTITLES_FOLDER_NAME);
    tokio::fs::create_dir_all(&folder).await.map_err(|error| error.to_string())?;
    let extension = if text.contains("[Script Info]") {
        "ass"
    } else if text.trim_start_matches('\u{feff}').starts_with("WEBVTT") {
        "vtt"
    } else {
        "srt"
    };
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_millis()).unwrap_or(0);
    let path = folder.join(format!("{stamp}.{extension}"));
    tokio::fs::write(&path, text).await.map_err(|error| error.to_string())?;
    send(&app, &mpv, &state.data_dir, json!(["sub-add", path.to_string_lossy(), "select", title])).await.map(|_| ())
}

#[tauri::command]
pub async fn mpv_audio_filter(app: AppHandle, state: State<'_, AppState>, mpv: State<'_, MpvState>, mode: String) -> Result<(), String> {
    let filter = AUDIO_FILTERS
        .iter()
        .find(|(name, _)| *name == mode)
        .map(|(_, filter)| *filter)
        .ok_or_else(|| "mpv_property_refused".to_owned())?;
    send(&app, &mpv, &state.data_dir, json!(["set_property", "af", filter])).await.map(|_| ())
}

#[tauri::command]
pub async fn mpv_stats(app: AppHandle, state: State<'_, AppState>, mpv: State<'_, MpvState>) -> Result<HashMap<String, Value>, String> {
    let mut stats = HashMap::new();
    for name in STATS_PROPERTIES {
        if let Ok(value) = send(&app, &mpv, &state.data_dir, json!(["get_property", name])).await {
            stats.insert((*name).to_owned(), value);
        }
    }
    Ok(stats)
}

pub fn screenshot_path(app: &AppHandle, label: &str, extension: &str) -> Result<PathBuf, String> {
    let folder = app
        .path()
        .picture_dir()
        .or_else(|_| app.path().download_dir())
        .map_err(|error| error.to_string())?
        .join(SCREENSHOT_FOLDER_NAME);
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let safe: String = label
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' })
        .take(80)
        .collect::<String>()
        .trim()
        .to_owned();
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_millis()).unwrap_or(0);
    let name = if safe.is_empty() { format!("Kinuza {stamp}.{extension}") } else { format!("{safe} {stamp}.{extension}") };
    Ok(folder.join(name))
}

#[tauri::command]
pub async fn mpv_screenshot(app: AppHandle, state: State<'_, AppState>, mpv: State<'_, MpvState>, label: String) -> Result<String, String> {
    let path = screenshot_path(&app, &label, "png")?;
    send(&app, &mpv, &state.data_dir, json!(["screenshot-to-file", path.to_string_lossy(), "video"])).await?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn mpv_quit(mpv: State<'_, MpvState>) -> Result<(), String> {
    shutdown(&mpv).await;
    Ok(())
}

pub async fn shutdown(mpv: &MpvState) {
    if let Some(mut player) = mpv.player.lock().await.take() {
        let _ = player.commands.send(json!({ "command": ["quit"] }).to_string());
        if tokio::time::timeout(Duration::from_secs(2), player.child.wait()).await.is_err() {
            let _ = player.child.kill().await;
        }
    }
}

pub fn clear_subtitle_files(data_dir: &Path) {
    let _ = std::fs::remove_dir_all(data_dir.join(SUBTITLES_FOLDER_NAME));
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "http://127.0.0.1:5000/token";

    fn allowed(command: Value) -> bool {
        let grants = FileGrants::default();
        allowed_command(command.as_array().unwrap(), BASE, &grants)
    }

    #[test]
    fn plays_only_our_streams() {
        assert!(allowed(json!(["loadfile", format!("{BASE}/stream/abc/0"), "replace"])));
        assert!(!allowed(json!(["loadfile", "https://example.com/film.mkv", "replace"])));
        assert!(!allowed(json!(["loadfile", format!("{BASE}/stream/abc/0"), "replace", -1, "script=evil.lua"])));
        assert!(!allowed(json!(["loadfile", format!("{BASE}/stream/abc/0"), "insert-next"])));
    }

    #[test]
    fn refuses_running_programs() {
        assert!(!allowed(json!(["run", "cmd.exe", "/c", "calc"])));
        assert!(!allowed(json!(["subprocess", ["calc"]])));
        assert!(!allowed(json!(["load-script", "evil.lua"])));
        assert!(allowed(json!(["seek", 12.5, "absolute+exact"])));
        assert!(allowed(json!(["stop"])));
    }

    #[test]
    fn pinned_build_is_valid() {
        let build = pinned_build().unwrap();
        assert!(build.asset.starts_with("mpv-x86_64-") && build.asset.ends_with(".7z"));
        assert_eq!(build.sha256.len(), 64);
        assert!(!build.tag.is_empty());
    }

    #[test]
    fn adds_only_chosen_subtitles() {
        assert!(!allowed(json!(["sub-add", "C:\\secret.txt", "select"])));
    }
}
