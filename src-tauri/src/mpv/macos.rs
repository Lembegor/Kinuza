//! mpv on macOS: libmpv runs inside Kinuza and draws through its render API into a layer under the web view
//! (macos_video.m). Commands use the same JSON IPC as on Windows, over a Unix socket in the per-user temp folder.

use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use anyhow::{anyhow, bail, Context};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{attach_ipc, Player, OPTIONS};

const SOCKET_WAIT: Duration = Duration::from_secs(8);

static VIDEO: Mutex<usize> = Mutex::new(0);

const MAC_OPTIONS: &[(&str, &str)] = &[
    ("vo", "libmpv"),
    // The bundled libmpv is 0.36, where the high-quality profile is still called gpu-hq.
    ("profile", "gpu-hq"),
    // ponytail: display-resample needs the display's refresh rate fed into the render API; audio sync until smooth motion matters on Mac.
    ("video-sync", "audio"),
];

#[repr(C)]
struct MpvHandle {
    _private: [u8; 0],
}

#[link(name = "mpv")]
extern "C" {
    fn mpv_create() -> *mut MpvHandle;
    fn mpv_set_option_string(handle: *mut MpvHandle, name: *const c_char, value: *const c_char) -> c_int;
    fn mpv_initialize(handle: *mut MpvHandle) -> c_int;
    fn mpv_terminate_destroy(handle: *mut MpvHandle);
    fn mpv_error_string(error: c_int) -> *const c_char;
}

extern "C" {
    fn kinuza_video_attach(webview: *mut c_void, handle: *mut MpvHandle) -> *mut c_void;
    fn kinuza_video_set_shown(video: *mut c_void, shown: bool);
    fn kinuza_video_place(video: *mut c_void, x: c_int, y: c_int, width: c_int, height: c_int);
    fn kinuza_video_detach(video: *mut c_void);
    fn kinuza_sleep_prevent(prevent: bool);
}

/// One libmpv core with its video surface. Dropping it tears both down in the order the render API needs.
struct Core {
    handle: *mut MpvHandle,
    video: *mut c_void,
    socket: PathBuf,
}

// libmpv handles may be used from any thread, and the video functions hop to the threads they need.
unsafe impl Send for Core {}

impl Drop for Core {
    fn drop(&mut self) {
        if self.handle.is_null() {
            return;
        }
        if let Ok(mut video) = VIDEO.lock() {
            if *video == self.video as usize {
                *video = 0;
            }
        }
        unsafe {
            kinuza_sleep_prevent(false);
            if !self.video.is_null() {
                kinuza_video_detach(self.video);
            }
            mpv_terminate_destroy(self.handle);
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}

pub struct Process {
    core: Core,
}

impl Process {
    /// ponytail: the core only ends when we drop it (a crash takes Kinuza down with it), so there is nothing to poll.
    pub fn alive(&mut self) -> bool {
        true
    }
}

pub fn available(_app: &AppHandle, _data_dir: &Path) -> bool {
    true
}

pub async fn start(app: &AppHandle, _data_dir: &Path, surface: bool) -> anyhow::Result<Player> {
    let socket = std::env::temp_dir().join(format!("kinuza-mpv-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let mut core = Core { handle: unsafe { mpv_create() }, video: std::ptr::null_mut(), socket: socket.clone() };
    if core.handle.is_null() {
        bail!("libmpv could not create a player");
    }

    let ipc = socket.to_string_lossy().into_owned();
    for &(name, value) in OPTIONS.iter().chain(MAC_OPTIONS).chain(&[("input-ipc-server", ipc.as_str())]) {
        set_option(core.handle, name, value);
    }
    let code = unsafe { mpv_initialize(core.handle) };
    if code < 0 {
        bail!("libmpv did not initialize: {}", error_text(code));
    }

    core.video = attach_video(app, core.handle as usize).await?;
    unsafe { kinuza_video_set_shown(core.video, surface) };
    if let Ok(mut video) = VIDEO.lock() {
        *video = core.video as usize;
    }
    if let Some(rect) = super::placed() {
        place(rect);
    }

    let (commands, replies) = attach_ipc(app, connect(&socket).await?);
    tracing::info!("mpv: started libmpv");
    Ok(Player { process: Process { core }, commands, replies })
}

/// libmpv builds differ in the options they know, so an unknown one is logged instead of stopping the player.
fn set_option(handle: *mut MpvHandle, name: &str, value: &str) {
    let (Ok(name_c), Ok(value_c)) = (CString::new(name), CString::new(value)) else { return };
    let code = unsafe { mpv_set_option_string(handle, name_c.as_ptr(), value_c.as_ptr()) };
    if code < 0 {
        tracing::warn!("mpv: option {name}={value} was not accepted: {}", error_text(code));
    }
}

fn error_text(code: c_int) -> String {
    unsafe { CStr::from_ptr(mpv_error_string(code)) }.to_string_lossy().into_owned()
}

/// `handle` travels as a number: raw pointers may not cross an await in a Tauri command.
async fn attach_video(app: &AppHandle, handle: usize) -> anyhow::Result<*mut c_void> {
    let window = app.get_webview_window("main").ok_or_else(|| anyhow!("the main window is gone"))?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window.with_webview(move |webview| {
        let video = unsafe { kinuza_video_attach(webview.inner(), handle as *mut MpvHandle) };
        let _ = sender.send(video as usize);
    })?;
    let video = receiver.await.context("the window closed before the video surface was ready")? as *mut c_void;
    if video.is_null() {
        bail!("could not set up the OpenGL video surface");
    }
    Ok(video)
}

async fn connect(socket: &Path) -> anyhow::Result<tokio::net::UnixStream> {
    let deadline = tokio::time::Instant::now() + SOCKET_WAIT;
    loop {
        match tokio::net::UnixStream::connect(socket).await {
            Ok(stream) => return Ok(stream),
            Err(_) if tokio::time::Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(80)).await,
            Err(error) => return Err(anyhow!("mpv did not open its control socket: {error}")),
        }
    }
}

pub async fn stop(player: Player) {
    drop(player);
}

pub fn surface(process: &Process, shown: bool) {
    unsafe { kinuza_video_set_shown(process.core.video, shown) };
}

pub fn place(rect: [i32; 4]) {
    let Ok(video) = VIDEO.lock() else { return };
    if *video != 0 {
        unsafe { kinuza_video_place(*video as *mut c_void, rect[0], rect[1], rect[2], rect[3]) };
    }
}

static PAUSED: AtomicBool = AtomicBool::new(true);
static IDLE: AtomicBool = AtomicBool::new(true);

/// With the render API mpv no longer keeps the display awake, so Kinuza does it while a film plays.
pub fn on_event(_app: &AppHandle, message: &Value) {
    if message.get("event").and_then(Value::as_str) != Some("property-change") {
        return;
    }
    let flag = match message.get("name").and_then(Value::as_str) {
        Some("pause") => &PAUSED,
        Some("idle-active") => &IDLE,
        _ => return,
    };
    flag.store(message.get("data").and_then(Value::as_bool).unwrap_or(true), Ordering::Relaxed);
    let playing = !PAUSED.load(Ordering::Relaxed) && !IDLE.load(Ordering::Relaxed);
    unsafe { kinuza_sleep_prevent(playing) };
}
