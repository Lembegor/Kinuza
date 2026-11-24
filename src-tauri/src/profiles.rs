use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::AppState;

const BOOK_FILE: &str = "profiles.json";
const PROFILES_FOLDER: &str = "profiles";
const REMOVED_FOLDER: &str = "removed";
const STORE_FOLDER: &str = "store";
const MAIN_ID: &str = "main";
const MAX_PROFILES: usize = 8;
const MAX_NAME_CHARS: usize = 40;
const COLORS: &[&str] = &["red", "orange", "yellow", "green", "teal", "blue", "violet", "pink"];

#[cfg(not(test))]
static ACTIVE: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

#[cfg(test)]
thread_local! {
    static ACTIVE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

#[cfg(not(test))]
fn read_active() -> Option<String> {
    ACTIVE.read().ok().and_then(|active| active.clone())
}

#[cfg(not(test))]
fn set_active(id: Option<String>) {
    if let Ok(mut active) = ACTIVE.write() {
        *active = id;
    }
}

#[cfg(test)]
fn read_active() -> Option<String> {
    ACTIVE.with(|active| active.borrow().clone())
}

#[cfg(test)]
fn set_active(id: Option<String>) {
    ACTIVE.with(|active| *active.borrow_mut() = id);
}
static BOOK_WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Entry {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    created: u64,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
struct Book {
    #[serde(default)]
    active: Option<String>,
    #[serde(default = "yes")]
    ask: bool,
    #[serde(default)]
    profiles: Vec<Entry>,
}

fn yes() -> bool {
    true
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    id: String,
    name: String,
    color: String,
    avatar: Option<String>,
    main: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesView {
    active: String,
    ask: bool,
    profiles: Vec<ProfileView>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|time| time.as_millis() as u64).unwrap_or(0)
}

fn valid_id(id: &str) -> bool {
    (8..=32).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit())
}

fn folder_of(data_dir: &Path, id: &str) -> PathBuf {
    if id == MAIN_ID {
        data_dir.to_path_buf()
    } else {
        data_dir.join(PROFILES_FOLDER).join(id)
    }
}

pub fn active_id() -> String {
    read_active().unwrap_or_else(|| MAIN_ID.to_owned())
}

pub fn personal_dir(data_dir: &Path) -> PathBuf {
    folder_of(data_dir, &active_id())
}

fn read_book(data_dir: &Path) -> Book {
    let mut book: Book = fs::read_to_string(data_dir.join(BOOK_FILE)).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or(Book {
        active: None,
        ask: true,
        profiles: Vec::new(),
    });
    book.profiles.retain(|entry| entry.id == MAIN_ID || valid_id(&entry.id));
    if !book.profiles.iter().any(|entry| entry.id == MAIN_ID) {
        book.profiles.insert(0, Entry { id: MAIN_ID.to_owned(), name: String::new(), color: COLORS[5].to_owned(), created: 0 });
    }
    book
}

fn write_book(data_dir: &Path, book: &Book) -> Result<(), String> {
    let text = serde_json::to_string_pretty(book).map_err(|error| error.to_string())?;
    crate::store::write_atomic(&data_dir.join(BOOK_FILE), text.as_bytes()).map_err(|error| {
        tracing::warn!("profiles: could not save the list: {error}");
        "profiles_save_failed".to_owned()
    })
}

pub fn start(data_dir: &Path) {
    let book = read_book(data_dir);
    let chosen = book
        .active
        .filter(|id| id != MAIN_ID && book.profiles.iter().any(|entry| &entry.id == id) && folder_of(data_dir, id).is_dir());
    if let Some(id) = &chosen {
        tracing::info!("profiles: starting in profile {id}");
    }
    set_active(chosen);
}

fn profile_document(data_dir: &Path, id: &str) -> Option<Value> {
    let text = fs::read_to_string(folder_of(data_dir, id).join(STORE_FOLDER).join("profile.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn view(data_dir: &Path, entry: &Entry) -> ProfileView {
    let document = profile_document(data_dir, &entry.id);
    let stored_name = document.as_ref().and_then(|value| value.get("name")).and_then(Value::as_str).unwrap_or("").trim().to_owned();
    let avatar = document.as_ref().and_then(|value| value.get("avatar")).and_then(Value::as_str).map(str::to_owned).filter(|avatar| !avatar.is_empty());
    ProfileView {
        id: entry.id.clone(),
        name: if stored_name.is_empty() { entry.name.clone() } else { stored_name },
        color: if COLORS.contains(&entry.color.as_str()) { entry.color.clone() } else { COLORS[5].to_owned() },
        avatar,
        main: entry.id == MAIN_ID,
    }
}

fn list(data_dir: &Path) -> ProfilesView {
    let book = read_book(data_dir);
    ProfilesView { active: active_id(), ask: book.ask, profiles: book.profiles.iter().map(|entry| view(data_dir, entry)).collect() }
}

fn clean_name(name: &str) -> String {
    name.trim().chars().filter(|c| !c.is_control()).take(MAX_NAME_CHARS).collect()
}

fn create(data_dir: &Path, name: &str, color: &str) -> Result<String, String> {
    let _guard = BOOK_WRITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut book = read_book(data_dir);
    if book.profiles.len() >= MAX_PROFILES {
        return Err("profiles_too_many".to_owned());
    }
    let name = clean_name(name);
    if name.is_empty() {
        return Err("profiles_name_missing".to_owned());
    }
    let id = crate::store::random_token().chars().filter(char::is_ascii_hexdigit).take(16).collect::<String>();
    let id = if valid_id(&id) { id } else { format!("{:016x}", now_ms()) };
    fs::create_dir_all(folder_of(data_dir, &id).join(STORE_FOLDER)).map_err(|error| {
        tracing::warn!("profiles: could not create a folder: {error}");
        "profiles_save_failed".to_owned()
    })?;
    let color = if COLORS.contains(&color) { color.to_owned() } else { COLORS[book.profiles.len() % COLORS.len()].to_owned() };
    book.profiles.push(Entry { id: id.clone(), name, color, created: now_ms() });
    write_book(data_dir, &book)?;
    tracing::info!("profiles: created {id}");
    Ok(id)
}

fn switch(data_dir: &Path, id: &str) -> Result<(), String> {
    let _guard = BOOK_WRITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut book = read_book(data_dir);
    if !book.profiles.iter().any(|entry| entry.id == id) {
        return Err("profiles_not_found".to_owned());
    }
    fs::create_dir_all(folder_of(data_dir, id)).map_err(|error| error.to_string())?;
    book.active = Some(id.to_owned());
    write_book(data_dir, &book)?;
    set_active((id != MAIN_ID).then(|| id.to_owned()));
    crate::account::forget_cached_token();
    tracing::info!("profiles: switched to {id}");
    Ok(())
}

fn update(data_dir: &Path, id: &str, name: Option<&str>, color: Option<&str>) -> Result<(), String> {
    let _guard = BOOK_WRITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut book = read_book(data_dir);
    let entry = book.profiles.iter_mut().find(|entry| entry.id == id).ok_or_else(|| "profiles_not_found".to_owned())?;
    if let Some(name) = name {
        entry.name = clean_name(name);
    }
    if let Some(color) = color.filter(|color| COLORS.contains(color)) {
        entry.color = color.to_owned();
    }
    write_book(data_dir, &book)
}

fn remove(data_dir: &Path, id: &str) -> Result<(), String> {
    let _guard = BOOK_WRITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if id == MAIN_ID || id == active_id() || !valid_id(id) {
        return Err("profiles_cannot_remove".to_owned());
    }
    let mut book = read_book(data_dir);
    let before = book.profiles.len();
    book.profiles.retain(|entry| entry.id != id);
    if book.profiles.len() == before {
        return Err("profiles_not_found".to_owned());
    }
    let folder = folder_of(data_dir, id);
    if folder.is_dir() {
        let kept = data_dir.join(PROFILES_FOLDER).join(REMOVED_FOLDER).join(format!("{id}-{}", now_ms()));
        fs::create_dir_all(kept.parent().unwrap_or(data_dir)).map_err(|error| error.to_string())?;
        fs::rename(&folder, &kept).map_err(|error| {
            tracing::warn!("profiles: could not put {id} aside: {error}");
            "profiles_save_failed".to_owned()
        })?;
    }
    write_book(data_dir, &book)?;
    tracing::info!("profiles: removed {id}");
    Ok(())
}

fn collect_hashes(value: &Value, found: &mut BTreeSet<String>) {
    let Some(sources) = value.get("sources").and_then(Value::as_object) else { return };
    for list in sources.values() {
        for source in list.as_array().into_iter().flatten() {
            if let Some(hash) = source.get("infoHash").and_then(Value::as_str) {
                found.insert(hash.to_ascii_lowercase());
            }
        }
    }
}

fn other_sources(data_dir: &Path) -> Vec<String> {
    let active = active_id();
    let mut found = BTreeSet::new();
    for entry in read_book(data_dir).profiles.iter().filter(|entry| entry.id != active) {
        let path = folder_of(data_dir, &entry.id).join(STORE_FOLDER).join("library.json");
        if let Some(value) = fs::read_to_string(path).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()) {
            collect_hashes(&value, &mut found);
        }
    }
    found.into_iter().collect()
}

pub fn personal_folders(data_dir: &Path) -> Vec<PathBuf> {
    let root = data_dir.join(PROFILES_FOLDER);
    if root.is_dir() {
        vec![root]
    } else {
        Vec::new()
    }
}

#[tauri::command(async)]
pub fn profiles_list(state: State<'_, AppState>) -> ProfilesView {
    list(&state.data_dir)
}

#[tauri::command(async)]
pub fn profiles_create(state: State<'_, AppState>, name: String, color: String) -> Result<String, String> {
    create(&state.data_dir, &name, &color)
}

#[tauri::command(async)]
pub fn profiles_switch(state: State<'_, AppState>, id: String) -> Result<(), String> {
    switch(&state.data_dir, &id)
}

#[tauri::command(async)]
pub fn profiles_update(state: State<'_, AppState>, id: String, name: Option<String>, color: Option<String>) -> Result<(), String> {
    update(&state.data_dir, &id, name.as_deref(), color.as_deref())
}

#[tauri::command(async)]
pub fn profiles_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    remove(&state.data_dir, &id)
}

#[tauri::command(async)]
pub fn profiles_set_ask(state: State<'_, AppState>, ask: bool) -> Result<(), String> {
    let _guard = BOOK_WRITES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut book = read_book(&state.data_dir);
    book.ask = ask;
    write_book(&state.data_dir, &book)
}

#[tauri::command(async)]
pub fn profiles_other_sources(state: State<'_, AppState>) -> Vec<String> {
    other_sources(&state.data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kinuza-profiles-{name}-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn reset() {
        set_active(None);
    }

    #[test]
    fn profiles_live_apart_and_main_stays_in_place() {
        reset();
        let dir = temp_dir("apart");
        assert_eq!(personal_dir(&dir), dir);
        let id = create(&dir, "  Маша  ", "pink").unwrap();
        let shown = list(&dir);
        assert_eq!(shown.profiles.len(), 2);
        assert!(shown.profiles[0].main);
        assert_eq!(shown.profiles[1].name, "Маша");
        assert_eq!(shown.profiles[1].color, "pink");
        switch(&dir, &id).unwrap();
        assert_eq!(personal_dir(&dir), dir.join(PROFILES_FOLDER).join(&id));
        reset();
        start(&dir);
        assert_eq!(active_id(), id);
        switch(&dir, MAIN_ID).unwrap();
        assert_eq!(personal_dir(&dir), dir);
        reset();
        start(&dir);
        assert_eq!(active_id(), MAIN_ID);
        reset();
    }

    #[test]
    fn removed_profiles_are_kept_aside_and_never_the_active_one() {
        reset();
        let dir = temp_dir("remove");
        let id = create(&dir, "Петя", "").unwrap();
        fs::write(folder_of(&dir, &id).join(STORE_FOLDER).join("library.json"), r#"{"sources":{"movie:1":[{"infoHash":"ABC"}]}}"#).unwrap();
        assert_eq!(other_sources(&dir), vec!["abc".to_owned()]);
        assert!(remove(&dir, MAIN_ID).is_err());
        switch(&dir, &id).unwrap();
        assert!(remove(&dir, &id).is_err());
        switch(&dir, MAIN_ID).unwrap();
        remove(&dir, &id).unwrap();
        assert_eq!(list(&dir).profiles.len(), 1);
        assert!(!folder_of(&dir, &id).exists());
        assert_eq!(fs::read_dir(dir.join(PROFILES_FOLDER).join(REMOVED_FOLDER)).unwrap().count(), 1);
        reset();
    }

    #[test]
    fn a_broken_list_or_missing_folder_falls_back_to_main() {
        reset();
        let dir = temp_dir("broken");
        fs::write(dir.join(BOOK_FILE), "{not json").unwrap();
        start(&dir);
        assert_eq!(active_id(), MAIN_ID);
        fs::write(dir.join(BOOK_FILE), r#"{"active":"0123456789abcdef","profiles":[{"id":"0123456789abcdef","name":"x"}]}"#).unwrap();
        start(&dir);
        assert_eq!(active_id(), MAIN_ID);
        assert!(create(&dir, "   ", "red").is_err());
        reset();
    }

}
