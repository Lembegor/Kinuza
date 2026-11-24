use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        OnceLock,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};

use crate::rutracker::{RutrackerItem, VideoSize};

const MIRRORS: &[&str] = &["https://channeluza.com/kinuza/rt/", "https://kinuza.channeluza.com/kinuza/rt/"];
pub(crate) const APP_KEY: &str = "tB1Ref_s4XVHOuc-yEep4je7F7gcIlaUv7WU9krMIi0";
const TOPIC_URL: &str = "https://rutracker.org/forum/viewtopic.php?t=";
const ERROR_PREFIX: &str = "gateway_";
const DOWN: &str = "gateway_down";
pub(crate) const STALL_SECONDS: u64 = 20;

pub(crate) fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("Kinuza/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(STALL_SECONDS))
            .timeout(Duration::from_secs(100))
            .build()
            .expect("gateway client")
    })
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
}

#[derive(Deserialize)]
struct SearchBody {
    items: Vec<SearchItem>,
    #[serde(default)]
    stale: Option<String>,
}

fn blocked_stale(body: &SearchBody) -> Option<String> {
    body.stale.as_deref().filter(|code| matches!(*code, "gateway_challenge" | "gateway_login" | "gateway_down")).map(str::to_owned)
}

#[derive(Deserialize)]
struct SearchItem {
    id: String,
    title: String,
    size: String,
    seeds: u32,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    state: String,
}

fn kind(requested: Option<String>) -> &'static str {
    match requested.as_deref() {
        Some("background") => "background",
        Some("secondary") => "secondary",
        _ => "interactive",
    }
}

fn error_code(raw: &str) -> String {
    let code = raw.trim();
    if code.starts_with(ERROR_PREFIX) || code.starts_with("tracker_") || code == "torrent_file_unavailable" {
        code.to_owned()
    } else {
        DOWN.to_owned()
    }
}

static WORKING_MIRROR: AtomicUsize = AtomicUsize::new(0);

async fn send(path: &str, query: &[(&str, String)]) -> Result<(reqwest::StatusCode, bytes::Bytes), String> {
    send_to(MIRRORS, &WORKING_MIRROR, path, query).await
}

pub(crate) async fn send_to(
    mirrors: &[&str],
    working: &AtomicUsize,
    path: &str,
    query: &[(&str, String)],
) -> Result<(reqwest::StatusCode, bytes::Bytes), String> {
    let first = working.load(Ordering::Relaxed) % mirrors.len();
    let mut answer = None;
    for step in 0..mirrors.len() {
        let index = (first + step) % mirrors.len();
        let mirror = mirrors[index];
        let attempt = async {
            let response = client().get(format!("{mirror}{path}")).header("X-Kinuza-Key", APP_KEY).query(query).send().await?;
            let status = response.status();
            Ok::<_, reqwest::Error>((status, response.bytes().await?))
        }
        .await;
        match attempt {
            Ok((status, body)) if status.is_success() || serde_json::from_slice::<ErrorBody>(&body).is_ok() => {
                working.store(index, Ordering::Relaxed);
                return Ok((status, body));
            }
            Ok((status, body)) => {
                tracing::warn!("gateway: {path} answered {status} without a gateway error at {mirror}");
                answer = Some((status, body));
            }
            Err(error) => tracing::warn!("gateway: {path} failed at {mirror}: {error}"),
        }
    }
    answer.ok_or_else(|| DOWN.to_owned())
}

async fn get(path: &str, query: &[(&str, String)]) -> Result<bytes::Bytes, String> {
    let (status, body) = send(path, query).await?;
    if status.is_success() {
        return Ok(body);
    }
    let code = serde_json::from_slice::<ErrorBody>(&body).map(|body| body.error).unwrap_or_default();
    tracing::warn!("gateway: {path} answered {status} {code}");
    Err(error_code(&code))
}

fn items_of(body: SearchBody) -> Vec<RutrackerItem> {
    body.items
        .into_iter()
        .filter(|item| !item.id.is_empty() && item.id.chars().all(|c| c.is_ascii_digit()))
        .map(|item| RutrackerItem {
            page_url: format!("{TOPIC_URL}{}", item.id),
            id: item.id,
            title: item.title,
            size: item.size,
            seeds: item.seeds,
        })
        .collect()
}

#[tauri::command]
pub async fn gateway_search(query: String, page: Option<u32>, kind_name: Option<String>) -> Result<Vec<RutrackerItem>, String> {
    let response = get(
        "search",
        &[("q", query), ("page", page.unwrap_or(0).to_string()), ("kind", kind(kind_name).to_owned())],
    )
    .await?;
    let body = serde_json::from_slice::<SearchBody>(&response).map_err(|_| DOWN.to_owned())?;
    if let Some(code) = blocked_stale(&body) {
        return Err(code);
    }
    Ok(items_of(body))
}

#[tauri::command]
pub async fn gateway_torrent_inspect(
    app_state: tauri::State<'_, crate::AppState>,
    id: String,
    max_age: Option<u64>,
    kind_name: Option<String>,
) -> Result<crate::engine::TorrentPreview, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("torrent_file_unavailable".to_owned());
    }
    let mut query = vec![("id", id), ("kind", kind(kind_name).to_owned())];
    if let Some(seconds) = max_age {
        query.push(("maxAge", seconds.to_string()));
    }
    let bytes = get("torrent", &query).await?;
    if bytes.first() != Some(&b'd') {
        return Err("torrent_file_unavailable".to_owned());
    }
    app_state.engine.inspect_torrent_file(bytes).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn gateway_video_sizes(ids: Vec<String>, kind_name: Option<String>) -> Result<HashMap<String, VideoSize>, String> {
    let ids: Vec<String> = ids.into_iter().filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit())).take(20).collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let response = get("sizes", &[("ids", ids.join(",")), ("kind", kind(kind_name).to_owned())]).await?;
    serde_json::from_slice::<HashMap<String, VideoSize>>(&response).map_err(|_| DOWN.to_owned())
}

#[tauri::command]
pub async fn gateway_status() -> GatewayStatus {
    match get("status", &[]).await {
        Ok(response) => serde_json::from_slice::<GatewayStatus>(&response).unwrap_or(GatewayStatus { state: "down".to_owned() }),
        Err(_) => GatewayStatus { state: "down".to_owned() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_errors_keep_their_meaning() {
        assert_eq!(error_code("gateway_login"), "gateway_login");
        assert_eq!(error_code("tracker_markup_changed"), "tracker_markup_changed");
        assert_eq!(error_code("forbidden"), DOWN);
        assert_eq!(error_code(""), DOWN);
        assert_eq!(error_code("gateway_busy"), "gateway_busy");
        assert_eq!(kind(Some("secondary".into())), "secondary");
        assert_eq!(kind(Some("anything".into())), "interactive");
    }

    #[test]
    fn found_items_get_topic_links() {
        let items = items_of(SearchBody {
            items: vec![
                SearchItem { id: "123".into(), title: "A".into(), size: "1 GB".into(), seeds: 3 },
                SearchItem { id: "x1".into(), title: "B".into(), size: "".into(), seeds: 0 },
            ],
            stale: None,
        });
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].page_url, "https://rutracker.org/forum/viewtopic.php?t=123");
    }

    #[test]
    fn old_results_from_a_blocked_server_are_not_offered() {
        let body = |stale: Option<&str>| SearchBody { items: Vec::new(), stale: stale.map(str::to_owned) };
        assert_eq!(blocked_stale(&body(Some("gateway_challenge"))).as_deref(), Some("gateway_challenge"));
        assert_eq!(blocked_stale(&body(Some("gateway_login"))).as_deref(), Some("gateway_login"));
        assert_eq!(blocked_stale(&body(Some("gateway_busy"))), None);
        assert_eq!(blocked_stale(&body(None)), None);
    }

    #[tokio::test]
    #[ignore]
    async fn live_gateway_answers() {
        let status = gateway_status().await;
        println!("status {}", status.state);
        let found = gateway_search("Интерстеллар".into(), Some(0), None).await.unwrap();
        println!("found {} first {:?}", found.len(), found.first().map(|item| item.title.clone()));
        assert!(!found.is_empty());
        let sizes = gateway_video_sizes(found.iter().take(3).map(|item| item.id.clone()).collect(), Some("secondary".into())).await.unwrap();
        println!("sizes {}", sizes.len());
    }
}
