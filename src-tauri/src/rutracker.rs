use reqwest::{Client, cookie::Jar};
use scraper::{Html, Selector};
use encoding_rs::WINDOWS_1251;
use percent_encoding::{percent_encode, NON_ALPHANUMERIC};
use std::sync::Arc;
use serde::Serialize;
use tokio::sync::Mutex;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RutrackerItem {
    pub id: String,
    pub title: String,
    pub size: String,
    pub seeds: u32,
    pub page_url: String,
}

pub struct RutrackerState {
    client: Client,
}

impl RutrackerState {
    pub fn new() -> Self {
        let jar = Arc::new(Jar::default());
        let client = Client::builder()
            .cookie_provider(jar)
            .build()
            .expect("Failed to build HTTP client");
        Self { client }
    }
}

#[tauri::command]
pub async fn rutracker_login(state: tauri::State<'_, Mutex<RutrackerState>>, user: String, pass: String) -> Result<(), String> {
    let client = &state.lock().await.client;
    
    // Формируем payload с кодировкой cp1251, так как форум не понимает UTF-8
    let login_btn = percent_encode("Вход".as_bytes(), NON_ALPHANUMERIC).to_string();
    let body = format!(
        "login_username={}&login_password={}&login={}",
        percent_encode(user.as_bytes(), NON_ALPHANUMERIC),
        percent_encode(pass.as_bytes(), NON_ALPHANUMERIC),
        login_btn
    );

    let res = client.post("https://rutracker.org/forum/login.php")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let (decoded, _, _) = WINDOWS_1251.decode(&bytes);
    
    if decoded.contains("Вы ввели неверное/неактивное имя пользователя или неверный пароль") {
        return Err("auth_failed".to_owned());
    }
    
    Ok(())
}

#[tauri::command]
pub async fn rutracker_search(state: tauri::State<'_, Mutex<RutrackerState>>, query: String) -> Result<Vec<RutrackerItem>, String> {
    let client = &state.lock().await.client;
    
    let (encoded_query, _, _) = WINDOWS_1251.encode(&query);
    let query_url = percent_encode(&encoded_query, NON_ALPHANUMERIC).to_string();
    let url = format!("https://rutracker.org/forum/tracker.php?nm={}", query_url);

    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let (decoded, _, _) = WINDOWS_1251.decode(&bytes);
    let html = decoded.into_owned();

    // Если нас редиректнуло на логин или на странице просят войти
    if html.contains("Для выполнения поиска вы должны быть зарегистрированы") || html.contains("login.php") {
        return Err("auth_required".to_owned());
    }

    let document = Html::parse_document(&html);
    let row_sel = Selector::parse("tr.hl-tr").unwrap();
    let link_sel = Selector::parse("a.tLink").unwrap();
    let size_sel = Selector::parse(".tor-size, td.tor-size").unwrap();
    let seed_sel = Selector::parse(".seedmed, b.seedmed").unwrap();

    let mut results = Vec::new();

    for row in document.select(&row_sel).take(8) {
        if let Some(link) = row.select(&link_sel).next() {
            let title = link.text().collect::<String>().trim().to_owned();
            let id = link.value().attr("data-topic_id").unwrap_or("").to_owned();
            
            let size = row.select(&size_sel).next()
                .map(|s| s.text().collect::<String>())
                .unwrap_or_default()
                .trim()
                .to_owned();
                
            let seeds = row.select(&seed_sel).next()
                .and_then(|s| s.text().collect::<String>().trim().parse::<u32>().ok())
                .unwrap_or(0);

            if !id.is_empty() {
                results.push(RutrackerItem {
                    page_url: format!("https://rutracker.org/forum/viewtopic.php?t={}", id),
                    id,
                    title,
                    size,
                    seeds,
                });
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn rutracker_magnet(state: tauri::State<'_, Mutex<RutrackerState>>, id: String) -> Result<String, String> {
    let client = &state.lock().await.client;
    let url = format!("https://rutracker.org/forum/viewtopic.php?t={}", id);
    
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let text = res.text().await.map_err(|e| e.to_string())?;

    let re = regex::Regex::new(r"magnet:\?xt=urn:btih:[a-zA-Z0-9]+").unwrap();
    if let Some(caps) = re.captures(&text) {
        Ok(caps[0].to_string())
    } else {
        Err("magnet_not_found".to_owned())
    }
}
