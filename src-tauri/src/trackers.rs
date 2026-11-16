use std::{collections::HashMap, sync::atomic::AtomicUsize, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{engine::TorrentPreview, gateway, AppState};

const MIRRORS: &[&str] = &["https://channeluza.com/kinuza/search/", "https://kinuza.channeluza.com/kinuza/search/"];
const SOURCES: &[&str] = &["nnm", "yts", "eztv", "aniliberty", "sukebei"];
const MAGNET_INSPECT_SECONDS: u64 = 90;
const UNAVAILABLE: &str = "torrent_file_unavailable";
const DOWN: &str = "gateway_down";

static WORKING_MIRROR: AtomicUsize = AtomicUsize::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerQuery {
    kind: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    original: String,
    #[serde(default)]
    english: String,
    year: Option<u32>,
    #[serde(default)]
    imdb: String,
    season: Option<u32>,
    episode: Option<u32>,
    #[serde(default)]
    anime: bool,
    #[serde(default)]
    adult: bool,
    #[serde(default)]
    language: String,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TrackerItem {
    source: String,
    id: String,
    title: String,
    name: String,
    size: String,
    size_bytes: u64,
    seeds: u32,
    leeches: u32,
    info_hash: String,
    magnet: String,
    page: String,
    torrent: String,
    minutes: u32,
    season: Option<u32>,
    episode_first: Option<u32>,
    episode_last: Option<u32>,
    detailed: bool,
}

#[derive(Deserialize, Serialize, Default)]
#[serde(default)]
pub struct TrackerAnswer {
    items: Vec<TrackerItem>,
    sources: HashMap<String, String>,
}

fn mirrors() -> Vec<String> {
    match std::env::var("KINUZA_SEARCH_URL") {
        Ok(custom) if custom.starts_with("http") => vec![if custom.ends_with('/') { custom } else { format!("{custom}/") }],
        _ => MIRRORS.iter().map(|mirror| (*mirror).to_owned()).collect(),
    }
}

async fn get(path: &str, query: &[(&str, String)]) -> Result<(reqwest::StatusCode, bytes::Bytes), String> {
    let owned = mirrors();
    let list: Vec<&str> = owned.iter().map(String::as_str).collect();
    gateway::send_to(&list, &WORKING_MIRROR, path, query).await
}

fn short(text: &str, limit: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(limit).collect()
}

fn hex40(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    if lower.len() == 40 && lower.chars().all(|c| c.is_ascii_hexdigit()) {
        lower
    } else {
        String::new()
    }
}

fn plain_id(text: &str) -> bool {
    !text.is_empty() && text.len() <= 64 && text.chars().all(|c| c.is_ascii_alphanumeric())
}

fn checked(item: TrackerItem) -> Option<TrackerItem> {
    if !SOURCES.contains(&item.source.as_str()) || !plain_id(&item.id) || item.title.trim().is_empty() {
        return None;
    }
    let magnet = if item.magnet.starts_with("magnet:?xt=urn:btih:") && item.magnet.len() <= 4096 { item.magnet.clone() } else { String::new() };
    let page = if item.page.starts_with("https://") { short(&item.page, 300) } else { String::new() };
    let torrent = if item.torrent.chars().all(|c| c.is_ascii_digit()) { short(&item.torrent, 20) } else { String::new() };
    Some(TrackerItem {
        title: short(&item.title, 600),
        name: short(&item.name, 300),
        size: short(&item.size, 24),
        info_hash: hex40(&item.info_hash),
        magnet,
        page,
        torrent,
        ..item
    })
}

#[tauri::command]
pub async fn trackers_search(query: TrackerQuery) -> Result<TrackerAnswer, String> {
    if query.kind != "movie" && query.kind != "tv" {
        return Err("bad_type".to_owned());
    }
    let mut params: Vec<(&str, String)> = vec![("type", query.kind.clone())];
    for (name, value) in [("title", &query.title), ("original", &query.original), ("english", &query.english)] {
        let value = short(value.trim(), 150);
        if !value.is_empty() {
            params.push((name, value));
        }
    }
    if query.imdb.starts_with("tt") && query.imdb.len() <= 12 && query.imdb[2..].chars().all(|c| c.is_ascii_digit()) {
        params.push(("imdb", query.imdb.clone()));
    }
    for (name, value) in [("year", query.year), ("season", query.season), ("episode", query.episode)] {
        if let Some(value) = value {
            params.push((name, value.to_string()));
        }
    }
    if query.anime {
        params.push(("anime", "1".to_owned()));
    }
    if query.adult {
        params.push(("adult", "1".to_owned()));
    }
    if query.language.len() == 2 && query.language.chars().all(|c| c.is_ascii_lowercase()) {
        params.push(("language", query.language.clone()));
    }
    let (status, body) = get("search", &params).await?;
    if !status.is_success() {
        tracing::warn!("trackers: search answered {status}");
        return Err(DOWN.to_owned());
    }
    let answer = serde_json::from_slice::<TrackerAnswer>(&body).map_err(|_| DOWN.to_owned())?;
    let sources = answer.sources.into_iter().filter(|(name, _)| SOURCES.contains(&name.as_str())).map(|(name, state)| (name, short(&state, 40))).collect();
    Ok(TrackerAnswer { items: answer.items.into_iter().filter_map(checked).collect(), sources })
}

#[tauri::command]
pub async fn trackers_inspect(
    state: State<'_, AppState>,
    source: String,
    id: String,
    link: Option<String>,
    magnet: Option<String>,
) -> Result<TorrentPreview, String> {
    if !SOURCES.contains(&source.as_str()) || !plain_id(&id) {
        return Err(UNAVAILABLE.to_owned());
    }
    let mut query = vec![("source", source.clone()), ("id", id.clone())];
    if let Some(link) = link.filter(|value| !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())) {
        query.push(("link", link));
    }
    if source != "eztv" {
        match get("torrent", &query).await {
            Ok((status, body)) if status.is_success() && body.first() == Some(&b'd') => {
                return state.engine.inspect_torrent_file(body).await.map_err(|error| error.to_string());
            }
            Ok((status, _)) => tracing::info!("trackers: {source} {id} has no torrent file on the server ({status})"),
            Err(error) => tracing::info!("trackers: {source} {id} torrent file failed: {error}"),
        }
    }
    let Some(magnet) = magnet.filter(|value| value.starts_with("magnet:?xt=urn:btih:") && value.len() <= 4096) else {
        return Err(UNAVAILABLE.to_owned());
    };
    let inspect = state.engine.inspect(librqbit::AddTorrent::from_url(magnet));
    match tokio::time::timeout(Duration::from_secs(MAGNET_INSPECT_SECONDS), inspect).await {
        Ok(result) => result.map_err(|error| error.to_string()),
        Err(_) => Err("timeout".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_from_the_server_are_checked() {
        let good = TrackerItem {
            source: "yts".into(),
            id: "abcdef".into(),
            title: "Film (2006) [2006, BDRip 1080p] Original (Eng)".into(),
            info_hash: "ABCDEF0123456789ABCDEF0123456789ABCDEF01".into(),
            magnet: "javascript:alert(1)".into(),
            page: "http://plain".into(),
            torrent: "12a".into(),
            ..Default::default()
        };
        let checked = checked(good.clone()).expect("kept");
        assert_eq!(checked.info_hash, "abcdef0123456789abcdef0123456789abcdef01");
        assert!(checked.magnet.is_empty());
        assert!(checked.page.is_empty());
        assert!(checked.torrent.is_empty());
        assert!(super::checked(TrackerItem { source: "evil".into(), ..good.clone() }).is_none());
        assert!(super::checked(TrackerItem { id: "../x".into(), ..good }).is_none());
    }

    #[test]
    fn answers_tolerate_new_fields() {
        let body = r#"{"items":[{"source":"nnm","id":"1","title":"T [2020, BDRip]","seeds":4,"mal":5,"future":true}],"sources":{"nnm":"ok","other":"ok"}}"#;
        let answer: TrackerAnswer = serde_json::from_str(body).unwrap();
        assert_eq!(answer.items.len(), 1);
        assert_eq!(answer.items[0].seeds, 4);
    }

    #[tokio::test]
    #[ignore]
    async fn live_search_answers() {
        let answer = trackers_search(TrackerQuery {
            kind: "movie".into(),
            title: "Сайлент Хилл".into(),
            original: "Silent Hill".into(),
            english: "Silent Hill".into(),
            year: Some(2006),
            imdb: "tt0384537".into(),
            season: None,
            episode: None,
            anime: false,
            adult: false,
            language: "en".into(),
        })
        .await
        .unwrap();
        println!("{:?} {}", answer.sources, answer.items.len());
        assert!(!answer.items.is_empty());
    }
}
