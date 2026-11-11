use std::path::PathBuf;

use librqbit::AddTorrent;
use serde::Serialize;
use tauri::State;

use crate::{
    associations::{self, AssociationStatus},
    engine::{TorrentPreview, TorrentView},
    external_player,
    launch::LaunchRequest,
    AppState,
};

const MAX_READABLE_FILE_BYTES: u64 = 8 * 1024 * 1024;
const ARCHIVE_TORRENT_PREFIX: &str = "https://archive.org/download/";

type CommandResult<T> = Result<T, String>;

fn to_message(error: anyhow::Error) -> String {
    error.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    stream_base_url: String,
    default_download_dir: String,
    external_player: Option<String>,
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        stream_base_url: state.stream_base_url.clone(),
        default_download_dir: state.default_download_dir.to_string_lossy().into_owned(),
        external_player: external_player::find().map(|player| player.name.to_owned()),
    }
}

#[tauri::command]
pub async fn torrent_inspect(
    state: State<'_, AppState>,
    link: Option<String>,
    path: Option<String>,
) -> CommandResult<TorrentPreview> {
    let source = match (link, path) {
        (Some(link), _) => {
            let link = link.trim().to_owned();
            if !is_supported_link(&link) {
                return Err("bad_link".to_owned());
            }
            AddTorrent::from_url(link)
        }
        (None, Some(path)) => {
            let bytes = std::fs::read(&path).map_err(|_| "torrent_file_unreadable".to_owned())?;
            AddTorrent::from_bytes(bytes)
        }
        (None, None) => return Err("no_source".to_owned()),
    };
    state.engine.inspect(source).await.map_err(to_message)
}

fn is_supported_link(link: &str) -> bool {
    link.to_ascii_lowercase().starts_with("magnet:?") || link.starts_with(ARCHIVE_TORRENT_PREFIX)
}

#[tauri::command]
pub async fn torrent_add(
    state: State<'_, AppState>,
    info_hash: String,
    files: Vec<usize>,
    download_dir: Option<String>,
) -> CommandResult<()> {
    let download_dir = download_dir
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.default_download_dir.clone());
    state
        .engine
        .add(&info_hash, files, &download_dir)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub fn torrent_list(state: State<'_, AppState>) -> Vec<TorrentView> {
    state.engine.list()
}

#[tauri::command]
pub async fn torrent_pause(state: State<'_, AppState>, info_hash: String) -> CommandResult<()> {
    state.engine.pause(&info_hash).await.map_err(to_message)
}

#[tauri::command]
pub async fn torrent_resume(state: State<'_, AppState>, info_hash: String) -> CommandResult<()> {
    state.engine.resume(&info_hash).await.map_err(to_message)
}

#[tauri::command]
pub async fn torrent_delete(
    state: State<'_, AppState>,
    info_hash: String,
    delete_files: bool,
) -> CommandResult<()> {
    state
        .engine
        .delete(&info_hash, delete_files)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn torrent_select_files(
    state: State<'_, AppState>,
    info_hash: String,
    files: Vec<usize>,
    download_dir: Option<String>,
) -> CommandResult<()> {
    let download_dir = download_dir
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.default_download_dir.clone());
    state
        .engine
        .select_files(&info_hash, &files, &download_dir)
        .await
        .map_err(to_message)
}

#[tauri::command]
pub async fn torrent_release(state: State<'_, AppState>, info_hash: String) -> CommandResult<()> {
    state.engine.release_online(&info_hash).await.map_err(to_message)
}

#[tauri::command]
pub fn torrent_set_policy(state: State<'_, AppState>, policy: crate::engine::DownloadPolicy) {
    state.engine.set_policy(policy);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    free_bytes: u64,
    total_bytes: u64,
    cache_bytes: u64,
}

#[tauri::command]
pub fn storage_info(state: State<'_, AppState>, download_dir: Option<String>) -> CommandResult<StorageInfo> {
    let folder = download_dir
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.default_download_dir.clone());
    let mut info = disk_space(&folder).ok_or_else(|| "storage_unknown".to_owned())?;
    info.cache_bytes = state.engine.cache_bytes();
    Ok(info)
}

#[tauri::command]
pub async fn stream_cache_clear(state: State<'_, AppState>) -> CommandResult<u64> {
    Ok(state.engine.clear_cache().await)
}

#[cfg(windows)]
fn disk_space(folder: &std::path::Path) -> Option<StorageInfo> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let existing = folder.ancestors().find(|path| path.exists())?;
    let wide: Vec<u16> = existing.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let (mut free, mut total) = (0u64, 0u64);
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, std::ptr::null_mut()) };
    (ok != 0).then_some(StorageInfo { free_bytes: free, total_bytes: total, cache_bytes: 0 })
}

#[cfg(not(windows))]
fn disk_space(_folder: &std::path::Path) -> Option<StorageInfo> {
    None
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> CommandResult<()> {
    std::fs::write(&path, contents).map_err(|_| "file_unwritable".to_owned())
}

#[tauri::command]
pub fn file_location(
    state: State<'_, AppState>,
    info_hash: String,
    file_index: usize,
) -> CommandResult<String> {
    state
        .engine
        .file_path(&info_hash, file_index)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(to_message)
}

#[tauri::command]
pub async fn open_external(
    state: State<'_, AppState>,
    info_hash: String,
    file_index: usize,
) -> CommandResult<String> {
    let player = external_player::find().ok_or_else(|| "no_external_player".to_owned())?;
    state
        .engine
        .prepare_stream(&info_hash, Some(file_index))
        .await
        .map_err(to_message)?;

    let target = if state.engine.is_file_complete(&info_hash, file_index) {
        state
            .engine
            .file_path(&info_hash, file_index)
            .map_err(to_message)?
            .to_string_lossy()
            .into_owned()
    } else {
        format!(
            "{}/stream/{}/{}",
            state.stream_base_url, info_hash, file_index
        )
    };
    external_player::launch(&player, &target).map_err(to_message)?;
    Ok(player.name.to_owned())
}

#[tauri::command]
pub fn read_file_bytes(path: String) -> CommandResult<tauri::ipc::Response> {
    let metadata = std::fs::metadata(&path).map_err(|_| "file_unreadable".to_owned())?;
    if metadata.len() > MAX_READABLE_FILE_BYTES {
        return Err("file_too_large".to_owned());
    }
    let bytes = std::fs::read(&path).map_err(|_| "file_unreadable".to_owned())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn take_launch_request(state: State<'_, AppState>) -> Option<LaunchRequest> {
    state.pending_launch.lock().ok()?.take()
}

#[tauri::command]
pub fn associations_status() -> AssociationStatus {
    associations::status()
}

#[tauri::command]
pub fn associations_set(enabled: bool) -> CommandResult<AssociationStatus> {
    let result = if enabled {
        associations::enable()
    } else {
        associations::disable()
    };
    result.map_err(|_| "associations_failed".to_owned())?;
    Ok(associations::status())
}

#[tauri::command]
pub fn open_default_apps_settings() -> CommandResult<()> {
    std::process::Command::new("explorer.exe")
        .arg("ms-settings:defaultapps")
        .spawn()
        .map(|_| ())
        .map_err(|_| "settings_unavailable".to_owned())
}
