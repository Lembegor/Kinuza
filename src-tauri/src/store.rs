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
const DAILY_BACKUPS_KEPT: usize = 14;
const BACKED_UP_STORES: &[&str] = &["library", "progress", "settings"];
const GUARDED_STORES: &[&str] = &["library", "progress"];
const COUNTED_SECTIONS: &[&str] = &["tracked", "progress"];
const SHRINK_TOLERANCE: usize = 3;
const REJECTED_FOLDER_NAME: &str = "rejected";
const REJECTED_KEPT: usize = 30;
const VERSION_FILE_NAME: &str = "app-version.txt";
const ERROR_SHRINK_REFUSED: &str = "store_shrink_refused";

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
struct Counts {
    tracked: Option<usize>,
    progress: Option<usize>,
}

impl Counts {
    fn of(text: &str) -> Option<Self> {
        let value: serde_json::Value = serde_json::from_str(text).ok()?;
        let section = |name: &str| value.get(name).and_then(|section| section.as_object()).map(|section| section.len());
        Some(Self { tracked: section(COUNTED_SECTIONS[0]), progress: section(COUNTED_SECTIONS[1]) })
    }

    fn describe(&self) -> String {
        let part = |label: &str, count: Option<usize>| count.map(|count| format!("{label} {count}"));
        [part("titles", self.tracked), part("progress", self.progress)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn lost(before: Option<usize>, after: Option<usize>) -> usize {
    match (before, after) {
        (Some(before), Some(after)) => before.saturating_sub(after),
        (Some(before), None) => before,
        _ => 0,
    }
}

fn shrinks_too_much(name: &str, before: Counts, after: Counts) -> bool {
    let progress_moved_out = name == "library" && after.progress.is_none();
    let progress_lost = if progress_moved_out { 0 } else { lost(before.progress, after.progress) };
    lost(before.tracked, after.tracked) > SHRINK_TOLERANCE || progress_lost > SHRINK_TOLERANCE
}
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
pub fn store_set(state: State<'_, AppState>, name: String, value: String, allow_shrink: Option<bool>) -> Result<(), String> {
    save_document(&state.data_dir.join(STORE_FOLDER_NAME), &name, &value, allow_shrink.unwrap_or(false))
}

fn save_document(folder: &Path, name: &str, value: &str, allow_shrink: bool) -> Result<(), String> {
    let guarded = GUARDED_STORES.contains(&name);
    let before = if guarded {
        document_path(folder, name).ok().and_then(|path| fs::read_to_string(path).ok()).and_then(|text| Counts::of(&text))
    } else {
        None
    };
    let after = if guarded { Counts::of(value) } else { None };
    if guarded && after.is_none() {
        tracing::error!("store: refused to save {name}: the new document is not valid JSON");
        return Err("store_invalid".to_owned());
    }
    if let (Some(before), Some(after)) = (before, after) {
        if shrinks_too_much(name, before, after) {
            if allow_shrink {
                tracing::warn!("store: {name} shrinks on purpose: {} -> {}", before.describe(), after.describe());
            } else {
                let kept = keep_rejected(folder, name, value);
                tracing::error!(
                    "store: refused to save {name}: it would drop from {} to {}; the rejected version is kept at {}",
                    before.describe(),
                    after.describe(),
                    kept.as_deref().map(|path| path.display().to_string()).unwrap_or_else(|| "nowhere".to_owned()),
                );
                return Err(ERROR_SHRINK_REFUSED.to_owned());
            }
        }
    }
    write_document(folder, name, value).map_err(|error| {
        tracing::warn!("store: could not save {name}: {error}");
        "store_unwritable".to_owned()
    })?;
    if let (Some(before), Some(after)) = (before, after) {
        if before != after {
            tracing::info!("store: saved {name}: {} -> {}", before.describe(), after.describe());
        }
    } else if let Some(after) = after {
        tracing::info!("store: saved {name} for the first time: {}", after.describe());
    }
    Ok(())
}

fn keep_rejected(folder: &Path, name: &str, value: &str) -> Option<PathBuf> {
    let rejected = folder.join(REJECTED_FOLDER_NAME);
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis()).unwrap_or(0);
    let path = rejected.join(format!("{name}-{stamp}.json"));
    write_atomic(&path, value.as_bytes()).ok()?;
    let mut old: Vec<PathBuf> = fs::read_dir(&rejected)
        .map(|entries| entries.filter_map(Result::ok).map(|entry| entry.path()).collect())
        .unwrap_or_default();
    old.sort();
    for stale in old.iter().take(old.len().saturating_sub(REJECTED_KEPT)) {
        let _ = fs::remove_file(stale);
    }
    Some(path)
}

pub fn snapshot_on_version_change(data_dir: &Path, version: &str) -> Option<String> {
    let folder = data_dir.join(STORE_FOLDER_NAME);
    let marker = folder.join(VERSION_FILE_NAME);
    let previous = fs::read_to_string(&marker).map(|text| text.trim().to_owned()).unwrap_or_default();
    if previous == version {
        return None;
    }
    let label = if previous.is_empty() { "unknown".to_owned() } else { previous.clone() };
    let backups = folder.join(BACKUP_FOLDER_NAME);
    let mut had_data = false;
    for name in BACKED_UP_STORES {
        let Ok(path) = document_path(&folder, name) else { continue };
        let Ok(text) = fs::read_to_string(&path) else { continue };
        if !is_json(&text) {
            continue;
        }
        had_data = true;
        let target = backups.join(format!("{name}-before-{version}-from-{label}.json"));
        match write_atomic(&target, text.as_bytes()) {
            Ok(()) => tracing::info!(
                "store: kept {name} as it was before {version} ({})",
                Counts::of(&text).map(|counts| counts.describe()).unwrap_or_default()
            ),
            Err(error) => tracing::warn!("store: could not keep {name} before {version}: {error}"),
        }
    }
    if let Err(error) = write_atomic(&marker, version.as_bytes()) {
        tracing::warn!("store: could not note the app version: {error}");
    } else {
        tracing::info!("store: app version {label} -> {version}");
    }
    had_data.then_some(previous)
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
                if GUARDED_STORES.contains(&name) {
                    let counts = Counts::of(&text).map(|counts| counts.describe()).unwrap_or_default();
                    tracing::info!("store: read {name} from {} ({counts})", candidate.file_name().map(|file| file.to_string_lossy()).unwrap_or_default());
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
    write_atomic(&target, text.as_bytes())?;
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

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut name = path.file_name().map(|name| name.to_os_string()).unwrap_or_default();
    name.push(".tmp");
    let temporary = path.with_file_name(name);
    {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&temporary, path).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

pub fn random_u64() -> u64 {
    use std::{
        collections::hash_map::RandomState,
        hash::{BuildHasher, Hasher},
    };
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u128(SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_nanos()).unwrap_or_default());
    hasher.finish()
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
    fn a_sudden_shrink_is_refused_and_kept_aside() {
        let folder = folder("shrink");
        let full = r#"{"tracked":{"a":1,"b":1,"c":1,"d":1,"e":1,"f":1},"progress":{"x":1}}"#;
        save_document(&folder, "library", full, false).unwrap();
        let small = r#"{"tracked":{"a":1},"progress":{"x":1}}"#;
        assert_eq!(save_document(&folder, "library", small, false), Err(ERROR_SHRINK_REFUSED.to_owned()));
        assert_eq!(fs::read_to_string(folder.join("library.json")).unwrap(), full);
        assert_eq!(fs::read_dir(folder.join(REJECTED_FOLDER_NAME)).unwrap().count(), 1);
        save_document(&folder, "library", small, true).unwrap();
        assert_eq!(fs::read_to_string(folder.join("library.json")).unwrap(), small);
    }

    #[test]
    fn small_changes_and_growth_are_saved() {
        let folder = folder("growth");
        save_document(&folder, "library", r#"{"tracked":{"a":1,"b":1,"c":1,"d":1},"progress":{}}"#, false).unwrap();
        save_document(&folder, "library", r#"{"tracked":{"a":1,"b":1},"progress":{}}"#, false).unwrap();
        save_document(&folder, "library", r#"{"tracked":{"a":1,"b":1,"c":1,"d":1,"e":1,"f":1,"g":1},"progress":{}}"#, false).unwrap();
        save_document(&folder, "progress", r#"{"version":3,"progress":{}}"#, false).unwrap();
        assert!(save_document(&folder, "library", "not json", false).is_err());
        save_document(&folder, "settings", r#"{}"#, false).unwrap();
    }

    #[test]
    fn progress_may_move_out_of_the_library() {
        let folder = folder("moved");
        save_document(&folder, "library", r#"{"tracked":{"a":1},"progress":{"1":1,"2":1,"3":1,"4":1,"5":1}}"#, false).unwrap();
        save_document(&folder, "library", r#"{"version":3,"tracked":{"a":1}}"#, false).unwrap();
        save_document(&folder, "progress", r#"{"version":3,"progress":{"1":1,"2":1,"3":1,"4":1,"5":1}}"#, false).unwrap();
        assert!(save_document(&folder, "progress", r#"{"version":3,"progress":{}}"#, false).is_err());
    }

    #[test]
    fn missing_section_counts_as_lost() {
        let folder = folder("missing");
        save_document(&folder, "library", r#"{"tracked":{"a":1,"b":1,"c":1,"d":1,"e":1},"progress":{}}"#, false).unwrap();
        assert!(save_document(&folder, "library", r#"{"progress":{}}"#, false).is_err());
    }

    #[test]
    fn a_new_version_keeps_the_old_files() {
        let folder = folder("version");
        let store = folder.join(STORE_FOLDER_NAME);
        assert_eq!(snapshot_on_version_change(&folder, "0.9.0"), None);
        save_document(&store, "library", r#"{"tracked":{"a":1},"progress":{}}"#, false).unwrap();
        assert_eq!(snapshot_on_version_change(&folder, "1.0.0"), Some("0.9.0".to_owned()));
        assert_eq!(snapshot_on_version_change(&folder, "1.0.0"), None);
        assert_eq!(snapshot_on_version_change(&folder, "1.1.0"), Some("1.0.0".to_owned()));
        let names: Vec<String> = fs::read_dir(store.join(BACKUP_FOLDER_NAME))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("-before-"))
            .collect();
        assert!(names.contains(&"library-before-1.0.0-from-0.9.0.json".to_owned()));
        assert!(names.contains(&"library-before-1.1.0-from-1.0.0.json".to_owned()));
        assert_eq!(names.len(), 2);
    }

    #[test]
    fn bad_names_are_refused() {
        let dir = folder("names");
        assert!(read_document(&dir, "../secret").is_err());
        assert!(write_document(&dir, "a/b", "{}").is_err());
    }
}
