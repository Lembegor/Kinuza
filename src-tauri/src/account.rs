use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};

use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::AppState;

const MIRRORS: &[&str] = &["https://kinuza.channeluza.com/kinuza/account/", "https://channeluza.com/kinuza/account/"];
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_FILE: &str = "account.key";
const SIGN_IN_SECONDS: u64 = 300;
const BACKUP_TEXT_LIMIT: usize = 96 * 1024 * 1024;
const SIGNED_OUT: &str = "account_signed_out";
const DOWN: &str = "account_down";

static WORKING_MIRROR: AtomicUsize = AtomicUsize::new(0);
static SIGN_IN_CANCELLED: AtomicBool = AtomicBool::new(false);
static TOKEN: Mutex<Option<String>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    signed_in: bool,
    base: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPull {
    revision: u64,
    text: Option<String>,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("Kinuza/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_default()
    })
}

fn mirrors() -> Vec<String> {
    match std::env::var("KINUZA_ACCOUNT_URL") {
        Ok(url) if url.starts_with("http") => vec![if url.ends_with('/') { url } else { format!("{url}/") }],
        _ => MIRRORS.iter().map(|mirror| (*mirror).to_owned()).collect(),
    }
}

fn base() -> String {
    let list = mirrors();
    list[WORKING_MIRROR.load(Ordering::Relaxed) % list.len()].clone()
}

fn random_text(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    if getrandom::fill(&mut buffer).is_err() {
        buffer.iter_mut().enumerate().for_each(|(index, byte)| *byte = (index as u8).wrapping_mul(31));
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buffer)
}

fn token_path(data_dir: &Path) -> PathBuf {
    data_dir.join(TOKEN_FILE)
}

#[cfg(windows)]
fn seal(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let done = unsafe { CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut output) };
    if done == 0 || output.pbData.is_null() {
        return None;
    }
    let sealed = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData as _) };
    Some(sealed)
}

#[cfg(windows)]
fn unseal(data: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    let done = unsafe {
        CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut output)
    };
    if done == 0 || output.pbData.is_null() {
        return None;
    }
    let opened = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(output.pbData as _) };
    Some(opened)
}

#[cfg(not(windows))]
fn seal(data: &[u8]) -> Option<Vec<u8>> {
    Some(data.to_vec())
}

#[cfg(not(windows))]
fn unseal(data: &[u8]) -> Option<Vec<u8>> {
    Some(data.to_vec())
}

fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_extension("tmp");
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
    }
    std::fs::rename(&temporary, path)
}

fn load_token(data_dir: &Path) -> Option<String> {
    if let Ok(known) = TOKEN.lock() {
        if known.is_some() {
            return known.clone();
        }
    }
    let mut sealed = Vec::new();
    std::fs::File::open(token_path(data_dir)).ok()?.read_to_end(&mut sealed).ok()?;
    let token = String::from_utf8(unseal(&sealed)?).ok().filter(|token| !token.is_empty() && token.len() < 200)?;
    if let Ok(mut known) = TOKEN.lock() {
        *known = Some(token.clone());
    }
    Some(token)
}

fn save_token(data_dir: &Path, token: &str) -> Result<(), String> {
    let sealed = seal(token.as_bytes()).ok_or("account_store_failed")?;
    write_private(&token_path(data_dir), &sealed).map_err(|error| {
        tracing::warn!("account: could not save the sign-in: {error}");
        "account_store_failed".to_owned()
    })?;
    if let Ok(mut known) = TOKEN.lock() {
        *known = Some(token.to_owned());
    }
    Ok(())
}

fn forget_token(data_dir: &Path) {
    if let Ok(mut known) = TOKEN.lock() {
        *known = None;
    }
    let _ = std::fs::remove_file(token_path(data_dir));
}

fn device_name() -> String {
    let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    let system = match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        other => other,
    };
    if host.is_empty() { system.to_owned() } else { format!("{system} · {}", host.chars().take(40).collect::<String>()) }
}

async fn send(build: impl Fn(&str) -> reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    let list = mirrors();
    let start = WORKING_MIRROR.load(Ordering::Relaxed);
    for step in 0..list.len() {
        let index = (start + step) % list.len();
        match build(&list[index]).send().await {
            Ok(response) if response.status().as_u16() < 500 || response.status().as_u16() == 503 => {
                WORKING_MIRROR.store(index, Ordering::Relaxed);
                return Ok(response);
            }
            Ok(response) => tracing::warn!("account: {} answered {}", list[index], response.status()),
            Err(error) => tracing::warn!("account: {} failed: {error}", list[index]),
        }
    }
    Err(DOWN.to_owned())
}

async fn error_of(response: reqwest::Response) -> String {
    let status = response.status();
    let code = response.json::<Value>().await.ok().and_then(|body| body.get("error").and_then(Value::as_str).map(str::to_owned));
    match code {
        Some(code) if code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':') && code.len() < 60 => code,
        _ => format!("account_http_{}", status.as_u16()),
    }
}

fn token_of(state: &AppState) -> Result<String, String> {
    load_token(&state.data_dir).ok_or_else(|| SIGNED_OUT.to_owned())
}

fn signed_out(state: &AppState, status: reqwest::StatusCode) -> Option<String> {
    (status == reqwest::StatusCode::UNAUTHORIZED).then(|| {
        forget_token(&state.data_dir);
        SIGNED_OUT.to_owned()
    })
}

#[tauri::command]
pub fn account_status(state: State<'_, AppState>) -> AccountStatus {
    AccountStatus { signed_in: load_token(&state.data_dir).is_some(), base: base() }
}

#[tauri::command]
pub fn account_cancel_sign_in() {
    SIGN_IN_CANCELLED.store(true, Ordering::SeqCst);
}

fn query_value(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == name).then(|| percent_decode(value))
    })
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => out.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                if let Ok(value) = u8::from_str_radix(&text[index + 1..index + 3], 16) {
                    out.push(value);
                    index += 2;
                } else {
                    out.push(b'%');
                }
            }
            byte => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn finished_page(success: bool) -> String {
    let (title, text) = if success {
        ("Готово", "Вход выполнен. Можно закрыть эту вкладку и вернуться в Kinuza.<br><span>Signed in. You can close this tab and return to Kinuza.</span>")
    } else {
        ("Вход отменён", "Вход не выполнен. Вернитесь в Kinuza и попробуйте ещё раз.<br><span>Sign-in was cancelled. Return to Kinuza and try again.</span>")
    };
    format!(
        "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><title>Kinuza</title><style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0e13;color:#f2f2f5;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif}}div{{text-align:center;max-width:460px;padding:24px}}b{{display:inline-grid;place-items:center;width:56px;height:56px;border-radius:16px;background:#e5484d;font-size:28px;margin-bottom:18px}}h1{{margin:0 0 10px;font-size:26px}}p{{color:#b9b9c6;line-height:1.55}}span{{color:#7d7d8c;font-size:14px}}</style></head><body><div><b>K</b><h1>{title}</h1><p>{text}</p></div></body></html>"
    )
}

async fn answer(stream: &mut tokio::net::TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn wait_for_code(listener: tokio::net::TcpListener, expected_state: &str) -> Result<String, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(SIGN_IN_SECONDS);
    loop {
        if SIGN_IN_CANCELLED.load(Ordering::SeqCst) {
            return Err("account_cancelled".to_owned());
        }
        let accepted = tokio::time::timeout(Duration::from_millis(500), listener.accept()).await;
        if tokio::time::Instant::now() > deadline {
            return Err("account_timeout".to_owned());
        }
        let Ok(Ok((mut stream, peer))) = accepted else { continue };
        if !peer.ip().is_loopback() {
            continue;
        }
        let mut buffer = vec![0u8; 8192];
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer)).await;
        let Ok(Ok(size)) = read else { continue };
        let head = String::from_utf8_lossy(&buffer[..size]).into_owned();
        let target = head.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("");
        let Some(query) = target.strip_prefix("/?") else {
            answer(&mut stream, "404 Not Found", "").await;
            continue;
        };
        if query_value(query, "state").as_deref() != Some(expected_state) {
            answer(&mut stream, "400 Bad Request", &finished_page(false)).await;
            continue;
        }
        if let Some(code) = query_value(query, "code").filter(|code| !code.is_empty() && code.len() < 512) {
            answer(&mut stream, "200 OK", &finished_page(true)).await;
            return Ok(code);
        }
        answer(&mut stream, "200 OK", &finished_page(false)).await;
        return Err("account_cancelled".to_owned());
    }
}

fn focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub async fn account_sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    use tauri_plugin_opener::OpenerExt;
    SIGN_IN_CANCELLED.store(false, Ordering::SeqCst);
    let config = send(|base| client().get(format!("{base}config"))).await?;
    let client_id = config
        .json::<Value>()
        .await
        .ok()
        .and_then(|body| body.get("googleClientId").and_then(Value::as_str).map(str::to_owned))
        .filter(|id| !id.is_empty() && id.len() < 200)
        .ok_or("account_not_ready")?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|_| "account_listen_failed")?;
    let port = listener.local_addr().map_err(|_| "account_listen_failed")?.port();
    let redirect = format!("http://127.0.0.1:{port}/");
    let verifier = random_text(48);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let expected_state = random_text(24);
    let url = reqwest::Url::parse_with_params(
        AUTH_URL,
        &[
            ("client_id", client_id.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("response_type", "code"),
            ("scope", "openid email profile"),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", expected_state.as_str()),
            ("prompt", "select_account"),
        ],
    )
    .map_err(|_| "account_failed")?;
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|_| "account_browser_failed")?;
    let code = wait_for_code(listener, &expected_state).await?;
    focus(&app);
    let body = json!({ "code": code, "verifier": verifier, "redirect": redirect, "device": device_name() });
    let response = send(|base| client().post(format!("{base}auth/google")).json(&body)).await?;
    if !response.status().is_success() {
        return Err(error_of(response).await);
    }
    let mut answer: Value = response.json().await.map_err(|_| DOWN.to_owned())?;
    let token = answer.get("token").and_then(Value::as_str).ok_or(DOWN)?.to_owned();
    save_token(&state.data_dir, &token)?;
    if let Some(object) = answer.as_object_mut() {
        object.remove("token");
    }
    tracing::info!("account: signed in");
    Ok(answer)
}

#[tauri::command]
pub async fn account_sign_in_dev(state: State<'_, AppState>, name: String) -> Result<Value, String> {
    let key = std::env::var("KINUZA_ACCOUNT_DEV_KEY").map_err(|_| "account_not_ready")?;
    let digest = Sha256::digest(name.as_bytes());
    let number = u64::from_le_bytes(digest[..8].try_into().unwrap_or_default()) % 1_000_000_000_000_000;
    let body = json!({ "sub": format!("9{number:015}"), "name": name, "device": device_name() });
    let response = send(|base| client().post(format!("{base}auth/dev")).header("X-Dev-Key", &key).json(&body)).await?;
    if !response.status().is_success() {
        return Err(error_of(response).await);
    }
    let mut answer: Value = response.json().await.map_err(|_| DOWN.to_owned())?;
    let token = answer.get("token").and_then(Value::as_str).ok_or(DOWN)?.to_owned();
    save_token(&state.data_dir, &token)?;
    if let Some(object) = answer.as_object_mut() {
        object.remove("token");
    }
    Ok(answer)
}

fn allowed(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        ("GET" | "PATCH" | "DELETE", "me")
            | ("POST", "presence" | "auth/signout" | "auth/signout-all")
            | ("POST", "friends/request" | "friends/accept" | "friends/decline" | "friends/cancel" | "friends/remove")
            | ("GET", "friends/lookup")
            | ("POST", "party/ticket")
            | ("GET", "party/wait")
    )
}

#[tauri::command]
pub async fn account_call(state: State<'_, AppState>, method: String, path: String, body: Option<Value>, query: Option<Vec<(String, String)>>) -> Result<Value, String> {
    if !allowed(&method, &path) {
        return Err("account_refused".to_owned());
    }
    let token = token_of(&state)?;
    let verb = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "account_refused")?;
    let query = query.unwrap_or_default();
    let response = send(|base| {
        let mut request = client().request(verb.clone(), format!("{base}{path}")).bearer_auth(&token).query(&query);
        if let Some(body) = &body {
            request = request.json(body);
        }
        request
    })
    .await?;
    if let Some(error) = signed_out(&state, response.status()) {
        return Err(error);
    }
    if !response.status().is_success() {
        return Err(error_of(response).await);
    }
    let value = response.json::<Value>().await.unwrap_or(Value::Null);
    if matches!(path.as_str(), "auth/signout" | "auth/signout-all") || (method == "DELETE" && path == "me") {
        forget_token(&state.data_dir);
    }
    Ok(value)
}

#[tauri::command]
pub fn account_forget(state: State<'_, AppState>) {
    forget_token(&state.data_dir);
}

#[tauri::command]
pub async fn account_sync_pull(state: State<'_, AppState>, known: u64) -> Result<BackupPull, String> {
    let token = token_of(&state)?;
    let response = send(|base| client().get(format!("{base}sync")).bearer_auth(&token).header("If-None-Match", known.to_string())).await?;
    if let Some(error) = signed_out(&state, response.status()) {
        return Err(error);
    }
    let revision = response.headers().get("X-Revision").and_then(|value| value.to_str().ok()).and_then(|value| value.parse::<u64>().ok()).unwrap_or(0);
    match response.status().as_u16() {
        204 | 304 => Ok(BackupPull { revision, text: None }),
        200 => {
            let packed = response.bytes().await.map_err(|_| DOWN.to_owned())?;
            let text = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
                let mut text = String::new();
                flate2::read::GzDecoder::new(&packed[..])
                    .take(BACKUP_TEXT_LIMIT as u64)
                    .read_to_string(&mut text)
                    .map_err(|_| "sync_damaged".to_owned())?;
                Ok(text)
            })
            .await
            .map_err(|error| error.to_string())??;
            Ok(BackupPull { revision, text: Some(text) })
        }
        _ => Err(error_of(response).await),
    }
}

#[tauri::command]
pub async fn account_sync_push(state: State<'_, AppState>, revision: u64, text: String) -> Result<u64, String> {
    if text.len() > BACKUP_TEXT_LIMIT {
        return Err("sync_too_large".to_owned());
    }
    let token = token_of(&state)?;
    let packed = tauri::async_runtime::spawn_blocking(move || {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(text.as_bytes()).and_then(|()| encoder.finish())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|_| "sync_failed".to_owned())?;
    let response = send(|base| {
        client()
            .put(format!("{base}sync"))
            .bearer_auth(&token)
            .header("If-Match", revision.to_string())
            .header("Content-Type", "application/octet-stream")
            .body(packed.clone())
    })
    .await?;
    if let Some(error) = signed_out(&state, response.status()) {
        return Err(error);
    }
    if response.status() == reqwest::StatusCode::CONFLICT {
        let current = response.json::<Value>().await.ok().and_then(|body| body.get("revision").and_then(Value::as_u64)).unwrap_or(0);
        return Err(format!("sync_conflict:{current}"));
    }
    if !response.status().is_success() {
        return Err(error_of(response).await);
    }
    response.json::<Value>().await.ok().and_then(|body| body.get("revision").and_then(Value::as_u64)).ok_or_else(|| DOWN.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_queries_are_read() {
        assert_eq!(query_value("state=a%2Bb&code=4%2F0Ab_c", "code").as_deref(), Some("4/0Ab_c"));
        assert_eq!(query_value("state=a%2Bb&code=x", "state").as_deref(), Some("a+b"));
        assert_eq!(query_value("error=access_denied", "code"), None);
    }

    #[test]
    fn only_known_paths_go_out() {
        assert!(allowed("GET", "me"));
        assert!(allowed("POST", "friends/request"));
        assert!(!allowed("POST", "sync"));
        assert!(!allowed("GET", "auth/dev"));
        assert!(!allowed("POST", "../admin"));
    }

    #[test]
    fn random_text_is_long_and_url_safe() {
        let text = random_text(48);
        assert_eq!(text.len(), 64);
        assert!(text.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(text, random_text(48));
    }

    #[test]
    fn the_saved_sign_in_reads_back() {
        let folder = std::env::temp_dir().join(format!("kinuza-account-test-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        save_token(&folder, "secret-token").unwrap();
        if let Ok(mut known) = TOKEN.lock() {
            *known = None;
        }
        assert_eq!(load_token(&folder).as_deref(), Some("secret-token"));
        #[cfg(windows)]
        {
            let raw = std::fs::read(token_path(&folder)).unwrap();
            assert!(!raw.windows(12).any(|window| window == b"secret-token"));
        }
        forget_token(&folder);
        assert!(load_token(&folder).is_none());
        let _ = std::fs::remove_dir_all(&folder);
    }
}
