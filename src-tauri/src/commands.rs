//! Tauri commands called from the UI. Errors cross the bridge as short machine-readable strings.

use std::path::PathBuf;

use librqbit::AddTorrent;
use serde::Serialize;
use tauri::State;

use crate::{
    engine::{TorrentPreview, TorrentView},
    external_player, AppState,
};

/// Subtitle files are small; anything bigger is refused instead of being pushed through the bridge.
const MAX_READABLE_FILE_BYTES: u64 = 8 * 1024 * 1024;

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
    magnet: Option<String>,
    path: Option<String>,
) -> CommandResult<TorrentPreview> {
    let source = match (magnet, path) {
        (Some(magnet), _) => AddTorrent::from_url(magnet.trim().to_owned()),
        (None, Some(path)) => {
            let bytes = std::fs::read(&path).map_err(|_| "torrent_file_unreadable".to_owned())?;
            AddTorrent::from_bytes(bytes)
        }
        (None, None) => return Err("no_source".to_owned()),
    };
    state.engine.inspect(source).await.map_err(to_message)
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
) -> CommandResult<()> {
    state
        .engine
        .select_files(&info_hash, &files)
        .await
        .map_err(to_message)
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

/// Opens a torrent file in an installed desktop player (for formats the built-in player cannot decode).
#[tauri::command]
pub async fn open_external(
    state: State<'_, AppState>,
    info_hash: String,
    file_index: usize,
) -> CommandResult<String> {
    let player = external_player::find().ok_or_else(|| "no_external_player".to_owned())?;
    state
        .engine
        .prepare_stream(&info_hash, file_index)
        .await
        .map_err(to_message)?;

    // A finished file is opened from disk; an unfinished one is streamed so playback can start now.
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
