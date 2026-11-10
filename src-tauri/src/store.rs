//! Small named JSON documents (library, settings) kept in the app data folder.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::State;

use crate::AppState;

const STORE_FOLDER_NAME: &str = "store";
const MAX_STORE_NAME_LENGTH: usize = 40;

#[tauri::command]
pub fn store_get(state: State<'_, AppState>, name: String) -> Result<Option<String>, String> {
    let path = document_path(&state.data_dir, &name)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("store_unreadable".to_owned()),
    }
}

/// Writes atomically: a crash mid-write leaves the previous document intact.
#[tauri::command]
pub fn store_set(state: State<'_, AppState>, name: String, value: String) -> Result<(), String> {
    let path = document_path(&state.data_dir, &name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "store_unwritable".to_owned())?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, value).map_err(|_| "store_unwritable".to_owned())?;
    fs::rename(&temporary, &path).map_err(|_| "store_unwritable".to_owned())
}

fn document_path(data_dir: &Path, name: &str) -> Result<PathBuf, String> {
    let valid = !name.is_empty()
        && name.len() <= MAX_STORE_NAME_LENGTH
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err("bad_store_name".to_owned());
    }
    Ok(data_dir.join(STORE_FOLDER_NAME).join(format!("{name}.json")))
}

/// A per-launch token that keeps other local programs from guessing stream URLs.
pub fn random_token() -> String {
    use std::{
        collections::hash_map::RandomState,
        hash::{BuildHasher, Hasher},
    };

    let mut hasher = RandomState::new().build_hasher();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    hasher.write_u128(nanos);
    let first = hasher.finish();
    let mut second_hasher = RandomState::new().build_hasher();
    second_hasher.write_u64(first);
    format!("{:016x}{:016x}", first, second_hasher.finish())
}
