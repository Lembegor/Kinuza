use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Deserialize;
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const MAX_READABLE_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Default)]
pub struct FileGrants {
    readable: Mutex<HashSet<PathBuf>>,
    writable: Mutex<HashSet<PathBuf>>,
}

impl FileGrants {
    pub fn may_read(&self, path: &Path) -> bool {
        self.readable.lock().map(|granted| granted.contains(path)).unwrap_or(false)
    }

    fn grant_read(&self, path: &Path) {
        if let Ok(mut granted) = self.readable.lock() {
            granted.insert(path.to_path_buf());
        }
    }

    fn grant_write(&self, path: &Path) {
        if let Ok(mut granted) = self.writable.lock() {
            granted.insert(path.to_path_buf());
        }
    }

    fn take_write(&self, path: &Path) -> bool {
        self.writable.lock().map(|mut granted| granted.remove(path)).unwrap_or(false)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDialog {
    title: String,
    filter_name: String,
    extensions: Vec<String>,
    #[serde(default)]
    default_name: Option<String>,
}

fn builder(window: &WebviewWindow, dialog: &FileDialog) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let extensions: Vec<&str> = dialog.extensions.iter().map(String::as_str).collect();
    let mut builder = window.dialog().file().set_parent(window).set_title(&dialog.title);
    if !extensions.is_empty() {
        builder = builder.add_filter(&dialog.filter_name, &extensions);
    }
    if let Some(name) = dialog.default_name.as_deref().filter(|name| !name.trim().is_empty()) {
        builder = builder.set_file_name(name);
    }
    builder
}

#[tauri::command]
pub async fn file_pick(window: WebviewWindow, grants: State<'_, FileGrants>, dialog: FileDialog) -> Result<Option<String>, String> {
    let picked = builder(&window, &dialog).blocking_pick_file();
    let Some(path) = picked.and_then(|file| file.into_path().ok()) else { return Ok(None) };
    grants.grant_read(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn file_save_target(window: WebviewWindow, grants: State<'_, FileGrants>, dialog: FileDialog) -> Result<Option<String>, String> {
    let picked = builder(&window, &dialog).blocking_save_file();
    let Some(path) = picked.and_then(|file| file.into_path().ok()) else { return Ok(None) };
    grants.grant_write(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn read_file_bytes(grants: State<'_, FileGrants>, path: String) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(path);
    if !grants.may_read(&path) {
        tracing::warn!("files: refused to read a file the person did not choose");
        return Err("file_not_chosen".to_owned());
    }
    let metadata = std::fs::metadata(&path).map_err(|_| "file_unreadable".to_owned())?;
    if metadata.len() > MAX_READABLE_FILE_BYTES {
        return Err("file_too_large".to_owned());
    }
    let bytes = std::fs::read(&path).map_err(|_| "file_unreadable".to_owned())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn write_text_file(grants: State<'_, FileGrants>, path: String, contents: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !grants.take_write(&path) {
        tracing::warn!("files: refused to write a file the person did not choose");
        return Err("file_not_chosen".to_owned());
    }
    crate::store::write_atomic(&path, contents.as_bytes()).map_err(|_| "file_unwritable".to_owned())
}

const PNG_SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
const MAX_SCREENSHOT_BYTES: usize = 64 * 1024 * 1024;

#[tauri::command]
pub fn save_screenshot(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("screenshot_invalid".to_owned());
    };
    if bytes.len() > MAX_SCREENSHOT_BYTES || !bytes.starts_with(PNG_SIGNATURE) {
        return Err("screenshot_invalid".to_owned());
    }
    let label = request
        .headers()
        .get("x-kinuza-label")
        .and_then(|value| value.to_str().ok())
        .map(|value| percent_encoding::percent_decode_str(value).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    let path = crate::mpv::screenshot_path(&app, &label, "png")?;
    crate::store::write_atomic(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
