use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::{engine::CacheItem, AppState};

const WEB_CACHE_MARK: &str = "clear-web-cache";
const WEB_FOLDER: &str = "EBWebView";
const WEB_CACHE_FOLDERS: &[&str] = &["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Service Worker/CacheStorage"];
const CURRENT_LOG: &str = "kinuza.log";
const ERROR_UNKNOWN_PART: &str = "storage_unknown_part";
const ERROR_FAILED: &str = "storage_clear_failed";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    path: String,
    free_bytes: u64,
    total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    id: &'static str,
    bytes: u64,
    clearable: bool,
    later: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReport {
    downloads_disk: Option<Disk>,
    data_disk: Option<Disk>,
    cache: Vec<CacheItem>,
    parts: Vec<Part>,
    web_cache_pending: bool,
}

fn size_of(path: &Path) -> u64 {
    crate::engine::allocated_bytes(path)
}

fn web_root(app: &AppHandle) -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    app.path().app_local_data_dir().ok().map(|folder| folder.join(WEB_FOLDER))
}

fn web_cache_bytes(root: &Path) -> u64 {
    WEB_CACHE_FOLDERS.iter().map(|folder| size_of(&root.join("Default").join(folder))).sum()
}

fn disk(folder: &Path) -> Option<Disk> {
    let (free_bytes, total_bytes) = crate::commands::disk_totals(folder)?;
    Some(Disk { path: folder.to_string_lossy().into_owned(), free_bytes, total_bytes })
}

fn old_logs_bytes(folder: &Path) -> u64 {
    std::fs::read_dir(folder)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy() != CURRENT_LOG)
                .map(|entry| size_of(&entry.path()))
                .sum()
        })
        .unwrap_or(0)
}

#[tauri::command]
pub fn storage_report(app: AppHandle, state: State<'_, AppState>, download_dir: Option<String>) -> StorageReport {
    let data_dir = &state.data_dir;
    let downloads = download_dir
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.default_download_dir.clone());
    let mut parts = vec![
        Part { id: "library", bytes: size_of(&data_dir.join("store")) + size_of(&data_dir.join("session")) + size_of(&data_dir.join("activity")), clearable: false, later: false },
        Part { id: "ffmpeg", bytes: size_of(&data_dir.join("ffmpeg")), clearable: true, later: false },
        Part { id: "imdb", bytes: size_of(&data_dir.join("imdb")), clearable: true, later: false },
        Part { id: "fingerprints", bytes: size_of(&data_dir.join("fingerprints")), clearable: true, later: false },
        Part { id: "logs", bytes: old_logs_bytes(&data_dir.join("logs")), clearable: true, later: false },
    ];
    if let Ok(local) = app.path().app_local_data_dir() {
        parts.push(Part { id: "catalog", bytes: size_of(&local.join("catalog")), clearable: false, later: false });
    }
    let mpv_copy = size_of(&data_dir.join("mpv"));
    if mpv_copy > 0 {
        parts.push(Part { id: "mpv", bytes: mpv_copy, clearable: crate::mpv::has_bundled(&app), later: false });
    }
    let mut web_cache_pending = false;
    if let Some(root) = web_root(&app) {
        let cache = web_cache_bytes(&root);
        let everything = size_of(&root);
        web_cache_pending = root.parent().is_some_and(|parent| parent.join(WEB_CACHE_MARK).exists());
        parts.push(Part { id: "webCache", bytes: cache, clearable: true, later: true });
        parts.push(Part { id: "webData", bytes: everything.saturating_sub(cache), clearable: false, later: false });
    }
    parts.retain(|part| part.bytes > 0 || part.id == "library");
    StorageReport {
        downloads_disk: disk(&downloads),
        data_disk: disk(data_dir),
        cache: state.engine.cache_items(),
        parts,
        web_cache_pending,
    }
}

fn remove_children(folder: &Path, keep: Option<&str>) -> u64 {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return 0;
    };
    let mut freed = 0;
    for entry in entries.flatten() {
        if keep.is_some_and(|name| entry.file_name().to_string_lossy() == name) {
            continue;
        }
        let path = entry.path();
        let size = size_of(&path);
        let removed = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        if removed.is_ok() {
            freed += size;
        }
    }
    freed
}

#[tauri::command]
pub fn storage_clear_part(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<u64, String> {
    let data_dir = &state.data_dir;
    let freed = match id.as_str() {
        "ffmpeg" | "imdb" | "fingerprints" => remove_children(&data_dir.join(&id), None),
        "logs" => remove_children(&data_dir.join("logs"), Some(CURRENT_LOG)),
        "mpv" if crate::mpv::has_bundled(&app) => remove_children(&data_dir.join("mpv"), None),
        "webCache" => {
            let root = web_root(&app).ok_or_else(|| ERROR_UNKNOWN_PART.to_owned())?;
            let mark = root.parent().map(|parent| parent.join(WEB_CACHE_MARK)).ok_or_else(|| ERROR_FAILED.to_owned())?;
            std::fs::write(mark, b"").map_err(|_| ERROR_FAILED.to_owned())?;
            0
        }
        _ => return Err(ERROR_UNKNOWN_PART.to_owned()),
    };
    tracing::info!("storage: cleared {id}, {} MB", freed >> 20);
    Ok(freed)
}

#[tauri::command]
pub async fn storage_drop_cached(state: State<'_, AppState>, info_hash: String) -> Result<u64, String> {
    state.engine.drop_cached(&info_hash).await.map_err(|error| crate::commands::to_message(error))
}

#[tauri::command]
pub async fn storage_free_download(state: State<'_, AppState>, info_hash: String) -> Result<u64, String> {
    state.engine.free_download(&info_hash).await.map_err(|error| crate::commands::to_message(error))
}

pub fn clear_pending_web_cache() {
    #[cfg(windows)]
    {
        let Some(local) = std::env::var_os("LOCALAPPDATA") else {
            return;
        };
        let app_folder = PathBuf::from(local).join("com.lembegor.kinuza");
        let mark = app_folder.join(WEB_CACHE_MARK);
        if !mark.exists() {
            return;
        }
        let profile = app_folder.join(WEB_FOLDER).join("Default");
        for folder in WEB_CACHE_FOLDERS {
            let _ = std::fs::remove_dir_all(profile.join(folder));
        }
        let _ = std::fs::remove_file(mark);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("kinuza-storage-{name}-{}", crate::store::random_u64()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn clearing_logs_keeps_the_current_one() {
        let logs = folder("logs");
        std::fs::write(logs.join(CURRENT_LOG), b"now").unwrap();
        std::fs::write(logs.join("kinuza.1.log"), b"older run").unwrap();
        std::fs::write(logs.join("kinuza.2.log"), b"even older").unwrap();
        assert!(old_logs_bytes(&logs) > 0);
        remove_children(&logs, Some(CURRENT_LOG));
        let left: Vec<String> = std::fs::read_dir(&logs).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, vec![CURRENT_LOG.to_owned()]);
    }

    #[test]
    fn clearing_a_part_removes_everything_inside() {
        let part = folder("part");
        std::fs::create_dir_all(part.join("bin")).unwrap();
        std::fs::write(part.join("bin").join("tool.exe"), vec![0u8; 4096]).unwrap();
        std::fs::write(part.join("readme.txt"), b"x").unwrap();
        assert!(remove_children(&part, None) > 0);
        assert_eq!(std::fs::read_dir(&part).unwrap().count(), 0);
    }
}
