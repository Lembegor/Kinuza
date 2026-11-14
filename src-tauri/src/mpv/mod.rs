#![cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code, unused_imports, unused_variables))]

//! The mpv player as every platform sees it: the commands the interface calls, the whitelists that guard them and
//! mpv's JSON IPC protocol. How mpv runs and where it draws lives in the platform modules.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

#[cfg(windows)]
pub use windows::{executable, has_bundled};

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot, Mutex},
};

use crate::{files::FileGrants, AppState};

const REPLY_WAIT: Duration = Duration::from_secs(5);
const TIME_EVENT_EVERY: Duration = Duration::from_millis(200);
const APPROXIMATE_ARCHIVE_BYTES: u64 = 33 * 1024 * 1024;
const EVENT_NAME: &str = "mpv-event";
const SUBTITLES_FOLDER_NAME: &str = "mpv-subtitles";

/// Options mpv gets on every platform; the platform modules add how it draws and how we talk to it.
const OPTIONS: &[(&str, &str)] = &[
    ("config", "no"),
    ("idle", "yes"),
    ("keep-open", "yes"),
    ("force-window", "no"),
    ("osc", "no"),
    ("osd-level", "0"),
    ("input-default-bindings", "no"),
    ("media-controls", "no"),
    ("input-vo-keyboard", "no"),
    ("input-cursor", "no"),
    ("cursor-autohide", "no"),
    ("terminal", "no"),
    ("hwdec", "auto-safe"),
    ("interpolation", "no"),
    ("audio-channels", "auto"),
    ("audio-exclusive", "no"),
    ("sub-auto", "no"),
    ("audio-file-auto", "no"),
    ("hr-seek", "yes"),
    ("volume-max", "150"),
    ("screenshot-format", "png"),
    ("screenshot-png-compression", "4"),
    ("cache", "yes"),
    ("cache-secs", "300"),
    ("demuxer-max-bytes", "1500MiB"),
    ("demuxer-max-back-bytes", "150MiB"),
    ("demuxer-readahead-secs", "300"),
    ("cache-pause-initial", "yes"),
    ("cache-pause-wait", "2"),
    ("network-timeout", "600"),
    ("stream-lavf-o", "reconnect=1,reconnect_streamed=1,reconnect_delay_max=5"),
    ("sub-border-size", "2.5"),
    ("sub-shadow-offset", "1"),
    ("sub-margin-y", "54"),
];

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

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use std::path::Path;

    use serde_json::Value;
    use tauri::AppHandle;

    pub struct Process;

    impl Process {
        pub fn alive(&mut self) -> bool {
            false
        }
    }

    pub fn available(_app: &AppHandle, _data_dir: &Path) -> bool {
        false
    }

    pub async fn start(_app: &AppHandle, _data_dir: &Path, _surface: bool) -> anyhow::Result<super::Player> {
        anyhow::bail!("embedding mpv is not supported on this system")
    }

    pub async fn stop(_player: super::Player) {}

    pub fn surface(_process: &Process, _shown: bool) {}

    pub fn place(_rect: [i32; 4]) {}

    pub fn on_event(_app: &AppHandle, _message: &Value) {}
}

#[cfg(not(windows))]
pub fn executable(_app: &AppHandle, _data_dir: &Path) -> Option<PathBuf> {
    None
}

#[cfg(not(windows))]
pub fn has_bundled(_app: &AppHandle) -> bool {
    false
}

#[derive(Default)]
pub struct MpvState {
    #[cfg_attr(not(windows), allow(dead_code))]
    install: Mutex<()>,
    installing: AtomicBool,
    downloaded_bytes: AtomicU64,
    total_bytes: AtomicU64,
    surface: AtomicBool,
    player: Mutex<Option<Player>>,
}

type Replies = Arc<std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

struct Player {
    process: platform::Process,
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

#[tauri::command]
pub fn mpv_status(handle: AppHandle, app: State<'_, AppState>, mpv: State<'_, MpvState>) -> MpvStatus {
    let total = mpv.total_bytes.load(Ordering::Relaxed);
    MpvStatus {
        installed: platform::available(&handle, &app.data_dir),
        installing: mpv.installing.load(Ordering::Relaxed),
        downloaded_bytes: mpv.downloaded_bytes.load(Ordering::Relaxed),
        total_bytes: if total > 0 { total } else { APPROXIMATE_ARCHIVE_BYTES },
    }
}

#[tauri::command]
pub async fn mpv_install(handle: AppHandle, app: State<'_, AppState>, mpv: State<'_, MpvState>) -> Result<(), String> {
    #[cfg(windows)]
    return windows::install(&handle, &app.data_dir, &mpv).await;
    #[cfg(not(windows))]
    {
        let _ = (handle, app, mpv);
        Err("mpv_unsupported".to_owned())
    }
}

/// Talks mpv's JSON IPC over `stream`: replies go back to whoever sent the request, events go to the interface.
fn attach_ipc<S>(app: &AppHandle, stream: S) -> (mpsc::UnboundedSender<String>, Replies)
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (reader, mut writer) = tokio::io::split(stream);
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
            if message.get("event").and_then(Value::as_str) == Some("end-file") && message.get("reason").and_then(Value::as_str) == Some("error") {
                tracing::warn!("mpv: playback failed: {}", message.get("file_error").and_then(|error| error.as_str()).unwrap_or("unknown error"));
            }
            platform::on_event(&events, &message);
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
    (commands, replies)
}

async fn send(app: &AppHandle, state: &MpvState, data_dir: &Path, command: Value) -> Result<Value, String> {
    let (commands, replies) = {
        let mut player = state.player.lock().await;
        let alive = match player.as_mut() {
            Some(running) => running.process.alive() && !running.commands.is_closed(),
            None => false,
        };
        if !alive {
            drop(player.take());
            *player = Some(platform::start(app, data_dir, state.surface.load(Ordering::Relaxed)).await.map_err(|error| {
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
        Some("audio-add") => command.len() <= 4 && text(1).is_some_and(|url| url.starts_with(&format!("{stream_base_url}/"))),
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
    if !platform::available(&app, &state.data_dir) {
        return Ok(());
    }
    send(&app, &mpv, &state.data_dir, json!(["get_property", "idle-active"])).await.map(|_| ())
}

/// Shows or hides mpv's picture behind the interface while the player is open.
#[tauri::command]
pub async fn mpv_surface(mpv: State<'_, MpvState>, shown: bool) -> Result<(), String> {
    mpv.surface.store(shown, Ordering::Relaxed);
    if let Some(player) = mpv.player.lock().await.as_ref() {
        platform::surface(&player.process, shown);
    }
    Ok(())
}

static PLACED: std::sync::Mutex<Option<[i32; 4]>> = std::sync::Mutex::new(None);

pub(super) fn placed() -> Option<[i32; 4]> {
    PLACED.lock().ok().and_then(|placed| *placed)
}

#[tauri::command]
pub fn mpv_place(x: f64, y: f64, width: f64, height: f64) {
    if ![x, y, width, height].iter().all(|value| value.is_finite()) {
        return;
    }
    let rect = [x.round() as i32, y.round() as i32, (width.round() as i32).max(1), (height.round() as i32).max(1)];
    if let Ok(mut placed) = PLACED.lock() {
        *placed = Some(rect);
    }
    platform::place(rect);
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
    if let Some(player) = mpv.player.lock().await.take() {
        platform::stop(player).await;
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
    fn adds_sound_only_from_our_server() {
        assert!(allowed(json!(["audio-add", format!("{BASE}/stream/abc/3"), "select", "Voice"])));
        assert!(!allowed(json!(["audio-add", "https://example.com/voice.mka", "select"])));
    }

    #[test]
    fn adds_only_chosen_subtitles() {
        assert!(!allowed(json!(["sub-add", "C:\\secret.txt", "select"])));
    }
}
