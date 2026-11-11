use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::State;

use crate::AppState;

const STORE_FOLDER_NAME: &str = "store";
const BACKUP_FOLDER_NAME: &str = "backups";
const MAX_STORE_NAME_LENGTH: usize = 40;
const DAILY_BACKUPS_KEPT: usize = 7;
const BACKED_UP_STORES: &[&str] = &["library", "settings"];
const SECONDS_PER_DAY: u64 = 86_400;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDocument {
    text: String,
    recovered: bool,
}

#[tauri::command]
pub fn store_get(state: State<'_, AppState>, name: String) -> Result<Option<StoredDocument>, String> {
    read_document(&state.data_dir.join(STORE_FOLDER_NAME), &name)
}

#[tauri::command]
pub fn store_set(state: State<'_, AppState>, name: String, value: String) -> Result<(), String> {
    write_document(&state.data_dir.join(STORE_FOLDER_NAME), &name, &value).map_err(|error| {
        tracing::warn!("store: could not save {name}: {error}");
        "store_unwritable".to_owned()
    })
}

fn read_document(folder: &Path, name: &str) -> Result<Option<StoredDocument>, String> {
    let path = document_path(folder, name)?;
    let main_missing = !path.exists();
    let mut damaged = false;
    for (index, candidate) in candidates(folder, name, &path).iter().enumerate() {
        match fs::read_to_string(candidate) {
            Ok(text) if is_json(&text) => {
                let recovered = index > 1 || (index == 1 && !main_missing);
                if index > 0 {
                    tracing::warn!("store: {name} was read from {}", candidate.display());
                }
                return Ok(Some(StoredDocument { text, recovered }));
            }
            Ok(_) => {
                damaged = true;
                tracing::warn!("store: {} is damaged", candidate.display());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                damaged = true;
                tracing::warn!("store: could not read {}: {error}", candidate.display());
            }
        }
    }
    if damaged {
        Err("store_unreadable".to_owned())
    } else {
        Ok(None)
    }
}

fn candidates(folder: &Path, name: &str, path: &Path) -> Vec<PathBuf> {
    let mut list = vec![path.to_path_buf(), previous_path(path)];
    list.extend(daily_backups(folder, name).into_iter().rev());
    list
}

fn is_json(text: &str) -> bool {
    serde_json::from_str::<serde::de::IgnoredAny>(text).is_ok()
}

fn previous_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

fn write_document(folder: &Path, name: &str, value: &str) -> std::io::Result<()> {
    let path = document_path(folder, name).map_err(std::io::Error::other)?;
    fs::create_dir_all(folder)?;
    let temporary = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(value.as_bytes())?;
        file.sync_all()?;
    }
    if path.exists() {
        if BACKED_UP_STORES.contains(&name) {
            if let Err(error) = keep_daily_backup(folder, name, &path) {
                tracing::warn!("store: could not back up {name}: {error}");
            }
        }
        let current_is_valid = fs::read_to_string(&path).map(|text| is_json(&text)).unwrap_or(false);
        if current_is_valid {
            fs::rename(&path, previous_path(&path))?;
        }
    }
    fs::rename(&temporary, &path)
}

fn keep_daily_backup(folder: &Path, name: &str, path: &Path) -> std::io::Result<()> {
    let backups = folder.join(BACKUP_FOLDER_NAME);
    let target = backups.join(format!("{name}-{}.json", today()));
    if target.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(path)?;
    if !is_json(&text) {
        return Ok(());
    }
    fs::create_dir_all(&backups)?;
    fs::write(&target, text)?;
    let existing = daily_backups(folder, name);
    for old in existing.iter().take(existing.len().saturating_sub(DAILY_BACKUPS_KEPT)) {
        let _ = fs::remove_file(old);
    }
    Ok(())
}

fn daily_backups(folder: &Path, name: &str) -> Vec<PathBuf> {
    let prefix = format!("{name}-");
    let mut found: Vec<PathBuf> = fs::read_dir(folder.join(BACKUP_FOLDER_NAME))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|file| file.to_str())
                        .and_then(|file| file.strip_prefix(&prefix))
                        .and_then(|rest| rest.strip_suffix(".json"))
                        .is_some_and(|date| date.len() == 10 && date.chars().all(|c| c.is_ascii_digit() || c == '-'))
                })
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    found
}

fn today() -> String {
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0);
    civil_date((seconds / SECONDS_PER_DAY) as i64)
}

fn civil_date(days: i64) -> String {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn document_path(folder: &Path, name: &str) -> Result<PathBuf, String> {
    let valid = !name.is_empty()
        && name.len() <= MAX_STORE_NAME_LENGTH
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err("bad_store_name".to_owned());
    }
    Ok(folder.join(format!("{name}.json")))
}

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

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("kinuza-store-{label}-{}", random_token()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn dates_are_civil() {
        assert_eq!(civil_date(0), "1970-01-01");
        assert_eq!(civil_date(20_403), "2025-11-11");
        assert_eq!(civil_date(11_016), "2000-02-29");
    }

    #[test]
    fn missing_document_is_none() {
        let dir = folder("missing");
        assert!(read_document(&dir, "library").unwrap().is_none());
    }

    #[test]
    fn writes_keep_the_previous_version() {
        let dir = folder("previous");
        write_document(&dir, "library", "{\"a\":1}").unwrap();
        write_document(&dir, "library", "{\"a\":2}").unwrap();
        let read = read_document(&dir, "library").unwrap().unwrap();
        assert_eq!(read.text, "{\"a\":2}");
        assert!(!read.recovered);
        assert_eq!(fs::read_to_string(dir.join("library.json.bak")).unwrap(), "{\"a\":1}");
        assert_eq!(daily_backups(&dir, "library").len(), 1);
    }

    #[test]
    fn damaged_document_falls_back_to_the_previous_one() {
        let dir = folder("damaged");
        write_document(&dir, "library", "{\"a\":1}").unwrap();
        write_document(&dir, "library", "{\"a\":2}").unwrap();
        fs::write(dir.join("library.json"), "{\"a\":").unwrap();
        let read = read_document(&dir, "library").unwrap().unwrap();
        assert_eq!(read.text, "{\"a\":1}");
        assert!(read.recovered);
    }

    #[test]
    fn interrupted_write_reads_the_previous_one_silently() {
        let dir = folder("interrupted");
        write_document(&dir, "library", "{\"a\":1}").unwrap();
        write_document(&dir, "library", "{\"a\":2}").unwrap();
        fs::remove_file(dir.join("library.json")).unwrap();
        let read = read_document(&dir, "library").unwrap().unwrap();
        assert_eq!(read.text, "{\"a\":1}");
        assert!(!read.recovered);
    }

    #[test]
    fn damaged_document_is_not_kept_as_previous() {
        let dir = folder("keep");
        write_document(&dir, "library", "{\"a\":1}").unwrap();
        write_document(&dir, "library", "{\"a\":2}").unwrap();
        fs::write(dir.join("library.json"), "garbage").unwrap();
        write_document(&dir, "library", "{\"a\":3}").unwrap();
        assert_eq!(fs::read_to_string(dir.join("library.json.bak")).unwrap(), "{\"a\":1}");
        assert_eq!(fs::read_to_string(dir.join("library.json")).unwrap(), "{\"a\":3}");
    }

    #[test]
    fn everything_damaged_is_an_error() {
        let dir = folder("broken");
        fs::write(dir.join("library.json"), "garbage").unwrap();
        assert!(read_document(&dir, "library").is_err());
    }

    #[test]
    fn bad_names_are_refused() {
        let dir = folder("names");
        assert!(read_document(&dir, "../secret").is_err());
        assert!(write_document(&dir, "a/b", "{}").is_err());
    }
}
