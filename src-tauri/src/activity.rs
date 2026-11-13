use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde_json::Value;
use tauri::State;

use crate::AppState;

const ACTIVITY_FOLDER_NAME: &str = "activity";
const MAX_EVENT_BYTES: usize = 8 * 1024;
const MAX_BATCH: usize = 500;
const MILLIS_PER_DAY: i64 = 86_400_000;

static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn folder(data_dir: &Path) -> PathBuf {
    data_dir.join(ACTIVITY_FOLDER_NAME)
}

fn civil_from_days(days: i64) -> (i64, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month)
}

fn month_file(at: i64) -> String {
    let (year, month) = civil_from_days(at.div_euclid(MILLIS_PER_DAY));
    format!("{year:04}-{month:02}.jsonl")
}

fn valid(event: &Value) -> Option<i64> {
    let object = event.as_object()?;
    object.get("type")?.as_str().filter(|kind| !kind.is_empty())?;
    let at = object.get("at")?.as_i64()?;
    (at > 0).then_some(at)
}

pub fn append(data_dir: &Path, events: &[Value]) -> Result<usize, String> {
    let folder = folder(data_dir);
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut written = 0;
    let mut grouped: std::collections::BTreeMap<String, String> = Default::default();
    for event in events.iter().take(MAX_BATCH) {
        let Some(at) = valid(event) else { continue };
        let Ok(line) = serde_json::to_string(event) else { continue };
        if line.len() > MAX_EVENT_BYTES {
            continue;
        }
        let text = grouped.entry(month_file(at)).or_default();
        text.push_str(&line);
        text.push('\n');
        written += 1;
    }
    for (name, text) in grouped {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(folder.join(name))
            .map_err(|error| error.to_string())?;
        file.write_all(text.as_bytes()).map_err(|error| error.to_string())?;
        file.sync_data().ok();
    }
    Ok(written)
}

pub fn read(data_dir: &Path, since: i64) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(folder(data_dir)) else { return Vec::new() };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "jsonl"))
        .collect();
    files.sort();
    let first = month_file(since.max(1));
    files
        .into_iter()
        .filter(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name >= first.as_str()))
        .filter_map(|path| fs::File::open(path).ok())
        .flat_map(|file| BufReader::new(file).lines().map_while(Result::ok).collect::<Vec<_>>())
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter(|event| valid(event).is_some_and(|at| at >= since))
        .collect()
}

#[tauri::command]
pub fn activity_append(state: State<'_, AppState>, events: Vec<Value>) -> Result<usize, String> {
    append(&state.data_dir, &events)
}

#[tauri::command]
pub fn activity_read(state: State<'_, AppState>, since: Option<i64>) -> Vec<Value> {
    read(&state.data_dir, since.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_go_to_their_month_and_read_back() {
        let dir = std::env::temp_dir().join(format!("kinuza-activity-{}", crate::store::random_u64()));
        let january = 1_767_225_600_000_i64;
        let february = 1_769_904_000_000_i64;
        let events = vec![
            serde_json::json!({ "type": "rating", "at": january, "rating": 8 }),
            serde_json::json!({ "type": "watched", "at": february }),
            serde_json::json!({ "at": february }),
            serde_json::json!("broken"),
        ];
        assert_eq!(append(&dir, &events).unwrap(), 2);
        assert!(dir.join(ACTIVITY_FOLDER_NAME).join("2026-01.jsonl").exists());
        assert!(dir.join(ACTIVITY_FOLDER_NAME).join("2026-02.jsonl").exists());
        assert_eq!(read(&dir, 0).len(), 2);
        assert_eq!(read(&dir, february).len(), 1);
        let _ = fs::remove_dir_all(dir);
    }
}
