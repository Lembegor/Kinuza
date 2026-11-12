use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const API_URL: &str = "https://api.opensubtitles.com/api/v1";
const USER_AGENT: &str = concat!("Kinuza v", env!("CARGO_PKG_VERSION"));
const MAX_RESULTS: usize = 40;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(40);
const HASH_CHUNK: usize = 64 * 1024;
const HASH_TIMEOUT: Duration = Duration::from_secs(30);

const ERROR_KEY: &str = "subtitles_key_invalid";
const ERROR_QUOTA: &str = "subtitles_quota";
const ERROR_UNAVAILABLE: &str = "subtitles_unavailable";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleQuery {
    tmdb_id: u64,
    season: Option<u32>,
    episode: Option<u32>,
    languages: Vec<String>,
    #[serde(default)]
    moviehash: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSubtitle {
    file_id: u64,
    language: String,
    release: String,
    downloads: u64,
    hearing_impaired: bool,
    machine_translated: bool,
    hash_match: bool,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

fn movie_hash(length: u64, head: &[u8], tail: &[u8]) -> String {
    let words = |bytes: &[u8]| {
        bytes
            .chunks_exact(8)
            .map(|word| u64::from_le_bytes(word.try_into().unwrap_or([0; 8])))
            .fold(0u64, u64::wrapping_add)
    };
    format!("{:016x}", length.wrapping_add(words(head)).wrapping_add(words(tail)))
}

#[tauri::command]
pub async fn subtitle_file_hash(state: tauri::State<'_, crate::AppState>, info_hash: String, file_index: usize) -> Result<String, String> {
    let engine = state.engine.clone();
    let read = async move {
        let handle = engine.prepare_stream(&info_hash, Some(file_index)).await.map_err(|error| error.to_string())?;
        let mut stream = handle.stream(file_index).await.map_err(|error| error.to_string())?;
        let length = stream.len();
        if length < (HASH_CHUNK * 2) as u64 {
            return Err("file_too_small".to_owned());
        }
        let mut head = vec![0u8; HASH_CHUNK];
        stream.read_exact(&mut head).await.map_err(|error| error.to_string())?;
        stream.seek(std::io::SeekFrom::Start(length - HASH_CHUNK as u64)).await.map_err(|error| error.to_string())?;
        let mut tail = vec![0u8; HASH_CHUNK];
        stream.read_exact(&mut tail).await.map_err(|error| error.to_string())?;
        Ok(movie_hash(length, &head, &tail))
    };
    tokio::time::timeout(HASH_TIMEOUT, read).await.map_err(|_| "hash_timeout".to_owned())?
}

fn failure(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => ERROR_KEY,
        406 | 429 => ERROR_QUOTA,
        _ => ERROR_UNAVAILABLE,
    }
    .to_owned()
}

#[tauri::command]
pub async fn online_subtitles_search(api_key: String, query: SubtitleQuery) -> Result<Vec<OnlineSubtitle>, String> {
    let mut parameters = vec![("languages", query.languages.join(","))];
    match (query.season, query.episode) {
        (Some(season), Some(episode)) => {
            parameters.push(("parent_tmdb_id", query.tmdb_id.to_string()));
            parameters.push(("season_number", season.to_string()));
            parameters.push(("episode_number", episode.to_string()));
        }
        _ => parameters.push(("tmdb_id", query.tmdb_id.to_string())),
    }
    if let Some(hash) = query.moviehash.filter(|hash| hash.len() == 16 && hash.chars().all(|c| c.is_ascii_hexdigit())) {
        parameters.push(("moviehash", hash));
    }

    let response = client()?
        .get(format!("{API_URL}/subtitles"))
        .header("Api-Key", api_key)
        .query(&parameters)
        .send()
        .await
        .map_err(|_| ERROR_UNAVAILABLE.to_owned())?;
    if !response.status().is_success() {
        return Err(failure(response.status()));
    }
    let body: Value = response.json().await.map_err(|_| ERROR_UNAVAILABLE.to_owned())?;

    let found = body["data"].as_array().cloned().unwrap_or_default();
    let mut subtitles: Vec<OnlineSubtitle> = found
        .iter()
        .filter_map(|entry| {
            let attributes = &entry["attributes"];
            Some(OnlineSubtitle {
                file_id: attributes["files"][0]["file_id"].as_u64()?,
                language: attributes["language"].as_str().unwrap_or_default().to_owned(),
                release: attributes["release"].as_str().unwrap_or_default().to_owned(),
                downloads: attributes["download_count"].as_u64().unwrap_or(0),
                hearing_impaired: attributes["hearing_impaired"].as_bool().unwrap_or(false),
                machine_translated: attributes["ai_translated"].as_bool().unwrap_or(false)
                    || attributes["machine_translated"].as_bool().unwrap_or(false),
                hash_match: attributes["moviehash_match"].as_bool().unwrap_or(false),
            })
        })
        .collect();
    subtitles.sort_by_key(|subtitle| !subtitle.hash_match);
    subtitles.truncate(MAX_RESULTS);
    Ok(subtitles)
}

#[tauri::command]
pub async fn online_subtitles_download(api_key: String, file_id: u64) -> Result<tauri::ipc::Response, String> {
    let client = client()?;
    let ticket = client
        .post(format!("{API_URL}/download"))
        .header("Api-Key", api_key)
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "file_id": file_id }))
        .send()
        .await
        .map_err(|_| ERROR_UNAVAILABLE.to_owned())?;
    if !ticket.status().is_success() {
        return Err(failure(ticket.status()));
    }
    let ticket: Value = ticket.json().await.map_err(|_| ERROR_UNAVAILABLE.to_owned())?;
    let link = ticket["link"].as_str().ok_or_else(|| ERROR_QUOTA.to_owned())?;

    let file = client.get(link).send().await.map_err(|_| ERROR_UNAVAILABLE.to_owned())?;
    if !file.status().is_success() {
        return Err(ERROR_UNAVAILABLE.to_owned());
    }
    let bytes = file.bytes().await.map_err(|_| ERROR_UNAVAILABLE.to_owned())?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_adds_length_and_words() {
        let head = [1u8, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0];
        let tail = [3u8, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(movie_hash(10, &head, &tail), format!("{:016x}", 16));
        assert_eq!(movie_hash(u64::MAX, &[1, 0, 0, 0, 0, 0, 0, 0], &[]), "0000000000000000");
    }
}
