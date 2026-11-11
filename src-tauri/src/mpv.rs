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
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, Mutex},
};

use crate::{files::FileGrants, AppState};

const RELEASE_API: &str = "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest";
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
];
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

struct Player {
    child: Child,
    commands: mpsc::UnboundedSender<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvStatus {
    installed: bool,
    installing: bool,
    downloaded_bytes: u64,
    total_bytes: u64,
}

pub fn executable(data_dir: &Path) -> Option<PathBuf> {
    let installed = data_dir.join(FOLDER_NAME).join(EXECUTABLE_NAME);
    installed.is_file().then_some(installed)
}

#[tauri::command]
pub fn mpv_status(app: State<'_, AppState>, mpv: State<'_, MpvState>) -> MpvStatus {
    let total = mpv.total_bytes.load(Ordering::Relaxed);
    MpvStatus {
        installed: executable(&app.data_dir).is_some(),
        installing: mpv.installing.load(Ordering::Relaxed),
        downloaded_bytes: mpv.downloaded_bytes.load(Ordering::Relaxed),
        total_bytes: if total > 0 { total } else { APPROXIMATE_ARCHIVE_BYTES },
    }
}

#[tauri::command]
pub async fn mpv_install(app: State<'_, AppState>, mpv: State<'_, MpvState>) -> Result<(), String> {
    let _installing = mpv.install.lock().await;
    if executable(&app.data_dir).is_some() {
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
struct Release {
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
}

fn wanted_asset(name: &str) -> bool {
    name.starts_with("mpv-x86_64-") && name.ends_with(".7z") && !name.contains("-v3-") && !name.contains("dev") && !name.contains("debug")
}

async fn install(folder: &Path, progress: &MpvState) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(folder.parent().unwrap_or(folder)).await?;
    let client = reqwest::Client::builder().user_agent(concat!("Kinuza/", env!("CARGO_PKG_VERSION"))).build()?;
    let release: Release = client.get(RELEASE_API).send().await?.error_for_status()?.json().await?;
    let asset = release
        .assets
        .into_iter()
        .find(|asset| wanted_asset(&asset.name))
        .ok_or_else(|| anyhow!("the release has no mpv build for x86_64"))?;
    let expected = asset
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| anyhow!("the release publishes no checksum for {}", asset.name))?;

    let archive = folder.with_extension("download.tmp");
    let mut response = client.get(&asset.browser_download_url).send().await?.error_for_status()?;
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

    let unpacked = {
        let (archive, folder) = (archive.clone(), folder.to_path_buf());
        tauri::async_runtime::spawn_blocking(move || unpack(&archive, &folder)).await?
    };
    let _ = tokio::fs::remove_file(&archive).await;
    unpacked?;

    let version = background(Command::new(folder.join(EXECUTABLE_NAME)).arg("--version")).output().await?;
    anyhow::ensure!(version.status.success(), "the unpacked mpv does not run");
    tracing::info!("mpv: installed {}", asset.name);
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

async fn spawn(app: &AppHandle, data_dir: &Path) -> anyhow::Result<Player> {
    let executable = executable(data_dir).ok_or_else(|| anyhow!("mpv_missing"))?;
    let window = main_window_handle(app)?;
    let pipe = pipe_name();
    let mut command = Command::new(&executable);
    command.args(mpv_arguments(window, &pipe));
    background(&mut command);
    let child = command.spawn().context("could not start mpv")?;

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
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            match message.get("event").and_then(Value::as_str) {
                Some("end-file") if message.get("reason").and_then(Value::as_str) == Some("error") => {
                    tracing::warn!("mpv: playback failed: {}", message.get("file_error").and_then(|error| error.as_str()).unwrap_or("unknown error"));
                }
                Some("video-reconfig") | Some("file-loaded") => place_below_interface(&events),
                _ => {}
            }
            let _ = events.emit(EVENT_NAME, message);
        }
        let _ = events.emit(EVENT_NAME, json!({ "event": "shutdown" }));
    });

    for (id, name) in OBSERVED.iter().enumerate() {
        let _ = commands.send(json!({ "command": ["observe_property", id + 1, name] }).to_string());
    }
    tracing::info!("mpv: started");
    Ok(Player { child, commands })
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

async fn send(app: &AppHandle, state: &MpvState, data_dir: &Path, message: Value) -> Result<(), String> {
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
    running.commands.send(message.to_string()).map_err(|_| "mpv_gone".to_owned())
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
    send(&app, &mpv, &state.data_dir, json!({ "command": command })).await
}

#[tauri::command]
pub async fn mpv_warm(app: AppHandle, state: State<'_, AppState>, mpv: State<'_, MpvState>) -> Result<(), String> {
    if executable(&state.data_dir).is_none() {
        return Ok(());
    }
    send(&app, &mpv, &state.data_dir, json!({ "command": ["get_property", "idle-active"] })).await
}

#[tauri::command]
pub async fn mpv_set(app: AppHandle, state: State<'_, AppState>, mpv: State<'_, MpvState>, name: String, value: Value) -> Result<(), String> {
    if !ALLOWED_PROPERTIES.contains(&name.as_str()) || !is_plain(&value) {
        tracing::warn!("mpv: refused to set {name}");
        return Err("mpv_property_refused".to_owned());
    }
    send(&app, &mpv, &state.data_dir, json!({ "command": ["set_property", name, value] })).await
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
    send(&app, &mpv, &state.data_dir, json!({ "command": ["sub-add", path.to_string_lossy(), "select", title] })).await
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
    fn adds_only_chosen_subtitles() {
        assert!(!allowed(json!(["sub-add", "C:\\secret.txt", "select"])));
    }
}
