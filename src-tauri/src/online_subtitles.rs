//! Subtitles from OpenSubtitles.com: a search by the catalog id of a film or episode, and the
//! download of one result. The API key belongs to the app's developer and is passed in by the UI.

use serde::{Deserialize, Serialize};
use serde_json::Value;

const API_URL: &str = "https://api.opensubtitles.com/api/v1";
/// The service requires every client to name itself.
const USER_AGENT: &str = concat!("Kinuza v", env!("CARGO_PKG_VERSION"));
const MAX_RESULTS: usize = 40;

const ERROR_KEY: &str = "subtitles_key_invalid";
const ERROR_QUOTA: &str = "subtitles_quota";
const ERROR_UNAVAILABLE: &str = "subtitles_unavailable";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleQuery {
    /// Catalog (TMDB) id of the film, or of the series for an episode.
    tmdb_id: u64,
    season: Option<u32>,
    episode: Option<u32>,
    /// Two-letter codes, most wanted first.
    languages: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineSubtitle {
    /// What `online_subtitles_download` is asked for.
    file_id: u64,
    language: String,
    /// The release the subtitles were timed to, as the uploader named it.
    release: String,
    downloads: u64,
    hearing_impaired: bool,
    machine_translated: bool,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent(USER_AGENT).build().map_err(|e| e.to_string())
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
    Ok(found
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
            })
        })
        .take(MAX_RESULTS)
        .collect())
}

/// The subtitle file's contents, in whatever encoding it was uploaded in.
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
