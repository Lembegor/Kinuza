//! mpv on Windows: a separate mpv.exe that draws into the main window (`--wid`) and takes commands over a named pipe.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::Ordering,
    time::Duration,
};

use anyhow::{anyhow, bail, Context};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, Command},
};

use super::{attach_ipc, MpvState, Player, OPTIONS};

const DOWNLOAD_BASE: &str = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download";
const PINNED_BUILD: &str = include_str!("../../mpv.lock.json");
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const FOLDER_NAME: &str = "mpv";
const EXECUTABLE_NAME: &str = "mpv.exe";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PIPE_WAIT: Duration = Duration::from_secs(8);

const WINDOWS_OPTIONS: &[(&str, &str)] = &[
    ("vo", "gpu-next"),
    ("gpu-api", "d3d11"),
    ("profile", "high-quality"),
    ("video-sync", "display-resample"),
    ("background-color", "#000000"),
];

pub struct Process(Child);

impl Process {
    pub fn alive(&mut self) -> bool {
        matches!(self.0.try_wait(), Ok(None))
    }
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

pub fn executable(app: &AppHandle, data_dir: &Path) -> Option<PathBuf> {
    bundled(app).or_else(|| downloaded(data_dir))
}

pub fn available(app: &AppHandle, data_dir: &Path) -> bool {
    executable(app, data_dir).is_some()
}

pub async fn install(handle: &AppHandle, data_dir: &Path, mpv: &MpvState) -> Result<(), String> {
    let _installing = mpv.install.lock().await;
    if executable(handle, data_dir).is_some() {
        return Ok(());
    }
    mpv.downloaded_bytes.store(0, Ordering::Relaxed);
    mpv.total_bytes.store(0, Ordering::Relaxed);
    mpv.installing.store(true, Ordering::Relaxed);
    let result = install_into(&data_dir.join(FOLDER_NAME), mpv).await;
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

async fn install_into(folder: &Path, progress: &MpvState) -> anyhow::Result<()> {
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
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn pipe_name() -> String {
    format!(r"\\.\pipe\kinuza-mpv-{}", std::process::id())
}

fn main_window_handle(app: &AppHandle) -> anyhow::Result<isize> {
    let window = app.get_webview_window("main").ok_or_else(|| anyhow!("the main window is gone"))?;
    Ok(window.hwnd()?.0 as isize)
}

fn arguments(window: isize, pipe: &str) -> Vec<String> {
    let mut arguments = vec![format!("--wid={window}"), format!("--input-ipc-server={pipe}")];
    arguments.extend(OPTIONS.iter().chain(WINDOWS_OPTIONS).map(|(name, value)| format!("--{name}={value}")));
    arguments
}

async fn open_pipe(name: &str) -> anyhow::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    let deadline = tokio::time::Instant::now() + PIPE_WAIT;
    loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(name) {
            Ok(pipe) => return Ok(pipe),
            Err(_) if tokio::time::Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(80)).await,
            Err(error) => return Err(anyhow!("mpv did not open its control pipe: {error}")),
        }
    }
}

pub async fn start(app: &AppHandle, data_dir: &Path, _surface: bool) -> anyhow::Result<Player> {
    let executable = executable(app, data_dir).ok_or_else(|| anyhow!("mpv_missing"))?;
    let window = main_window_handle(app)?;
    let pipe = pipe_name();
    let mut command = Command::new(&executable);
    command.args(arguments(window, &pipe));
    background(&mut command);
    let child = crate::children::spawn(&mut command).context("could not start mpv")?;
    let (commands, replies) = attach_ipc(app, open_pipe(&pipe).await?);
    tracing::info!("mpv: started");
    Ok(Player { process: Process(child), commands, replies })
}

pub async fn stop(mut player: Player) {
    let _ = player.commands.send(json!({ "command": ["quit"] }).to_string());
    if tokio::time::timeout(Duration::from_secs(2), player.process.0.wait()).await.is_err() {
        let _ = player.process.0.kill().await;
    }
}

/// The transparent web view always lets mpv's window show through on Windows.
pub fn surface(_process: &Process, _shown: bool) {}

pub fn on_event(app: &AppHandle, message: &Value) {
    if matches!(message.get("event").and_then(Value::as_str), Some("video-reconfig" | "file-loaded")) {
        place_below_interface(app);
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_build_is_valid() {
        let build = pinned_build().unwrap();
        assert!(build.asset.starts_with("mpv-x86_64-") && build.asset.ends_with(".7z"));
        assert_eq!(build.sha256.len(), 64);
        assert!(!build.tag.is_empty());
    }

    #[test]
    fn passes_every_option_as_a_flag() {
        let arguments = arguments(7, "pipe");
        assert_eq!(arguments[..2], ["--wid=7".to_owned(), "--input-ipc-server=pipe".to_owned()]);
        assert!(arguments.contains(&"--config=no".to_owned()));
        assert!(arguments.contains(&"--vo=gpu-next".to_owned()));
    }
}
