use std::{path::Path, time::Duration};

use serde::Deserialize;
use tauri::State;

use crate::AppState;

const TELEGRAM_API: &str = "https://api.telegram.org";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const LOG_FILES_SENT: usize = 3;
const LOG_TAIL_BYTES: usize = 1_500_000;
const CAPTION_LIMIT: usize = 900;
const DESCRIPTION_LIMIT: usize = 4000;
const ERROR_UNCONFIGURED: &str = "report_unconfigured";
const ERROR_FAILED: &str = "report_failed";
const ERROR_EMPTY: &str = "report_empty";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRequest {
    description: String,
    sender: String,
    journal: String,
    settings: String,
    include_log: bool,
}

fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok().filter(|path| path.len() > 3)
}

fn user_name() -> Option<String> {
    std::env::var("USERNAME").or_else(|_| std::env::var("USER")).ok().filter(|name| name.len() >= 3)
}

fn redact_after(text: &str, marker: &str, keep: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(marker) {
        let (before, after) = rest.split_at(index + marker.len());
        out.push_str(before);
        let end = after.find(|c: char| c == '&' || c == '"' || c == '\'' || c.is_whitespace()).unwrap_or(after.len());
        out.push_str(keep);
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

fn redact_stream_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find("127.0.0.1:") {
        let (before, after) = rest.split_at(index);
        out.push_str(before);
        let port_end = after["127.0.0.1:".len()..].find(|c: char| !c.is_ascii_digit()).map(|offset| offset + "127.0.0.1:".len()).unwrap_or(after.len());
        out.push_str(&after[..port_end]);
        let tail = &after[port_end..];
        let token = tail.strip_prefix('/').map(|path| path.chars().take_while(|c| c.is_ascii_hexdigit()).count()).unwrap_or(0);
        if token >= 16 {
            out.push_str("/<token>");
            rest = &tail[1 + token..];
        } else {
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

fn redact_bot_tokens(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let digits = chars[index..].iter().take_while(|c| c.is_ascii_digit()).count();
        if digits >= 6 && chars.get(index + digits) == Some(&':') {
            let secret = chars[index + digits + 1..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == '_' || **c == '-').count();
            if secret >= 30 {
                out.push_str("<bot-token>");
                index += digits + 1 + secret;
                continue;
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

pub fn sanitize(text: &str) -> String {
    let mut clean = text.to_owned();
    if let Some(home) = home_dir() {
        for form in [home.clone(), home.replace('\\', "\\\\"), home.replace('\\', "/")] {
            clean = clean.replace(&form, "~");
        }
    }
    if let Some(name) = user_name() {
        clean = clean.replace(&format!("\\{name}"), "\\<user>").replace(&format!("/{name}"), "/<user>");
    }
    for marker in ["pk=", "passkey=", "api_key=", "apikey=", "Api-Key: ", "token="] {
        clean = redact_after(&clean, marker, "...");
    }
    redact_bot_tokens(&redact_stream_tokens(&clean))
}

fn tail(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut start = text.len() - limit;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let start = text[start..].find('\n').map(|offset| start + offset + 1).unwrap_or(start);
    &text[start..]
}

fn read_logs(data_dir: &Path) -> String {
    let folder = crate::logging::folder(data_dir);
    let mut out = String::new();
    for index in 0..LOG_FILES_SENT {
        let name = if index == 0 { "kinuza.log".to_owned() } else { format!("kinuza.{index}.log") };
        let Ok(bytes) = std::fs::read(folder.join(&name)) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        out.push_str(&format!("\n===== {name} =====\n"));
        out.push_str(tail(&text, LOG_TAIL_BYTES));
    }
    out
}

fn build_report(app: &tauri::AppHandle, data_dir: &Path, request: &ReportRequest) -> String {
    let version = app.package_info().version.to_string();
    let description: String = request.description.chars().take(DESCRIPTION_LIMIT).collect();
    let mut report = format!(
        "Kinuza problem report\nVersion: {version}\nSystem: {} {}\nFrom: {}\n\n----- What happened -----\n{}\n\n----- App journal -----\n{}\n\n----- Settings -----\n{}\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        if request.sender.trim().is_empty() { "-" } else { request.sender.trim() },
        description.trim(),
        request.journal.trim(),
        request.settings.trim(),
    );
    if request.include_log {
        report.push_str("\n----- Log -----");
        report.push_str(&read_logs(data_dir));
    }
    sanitize(&report)
}

#[tauri::command]
pub fn report_build(app: tauri::AppHandle, state: State<'_, AppState>, request: ReportRequest) -> String {
    build_report(&app, &state.data_dir, &request)
}

#[tauri::command]
pub async fn report_send(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: String,
    chat_id: String,
    request: ReportRequest,
) -> Result<(), String> {
    if token.trim().is_empty() || chat_id.trim().is_empty() {
        return Err(ERROR_UNCONFIGURED.to_owned());
    }
    if request.description.trim().is_empty() {
        return Err(ERROR_EMPTY.to_owned());
    }
    let report = build_report(&app, &state.data_dir, &request);
    let version = app.package_info().version.to_string();
    let sender = request.sender.trim();
    let summary: String = request.description.trim().chars().take(CAPTION_LIMIT).collect();
    let caption = sanitize(&format!("Kinuza {version}{}\n\n{summary}", if sender.is_empty() { String::new() } else { format!(" · {sender}") }));
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_secs()).unwrap_or(0);
    let file = reqwest::multipart::Part::bytes(report.into_bytes())
        .file_name(format!("kinuza-report-{stamp}.txt"))
        .mime_str("text/plain; charset=utf-8")
        .map_err(|error| error.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("chat_id", chat_id.trim().to_owned())
        .text("caption", caption)
        .part("document", file);
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(format!("{TELEGRAM_API}/bot{}/sendDocument", token.trim()))
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            tracing::warn!("report: could not reach Telegram: {}", sanitize(&error.to_string()));
            ERROR_FAILED.to_owned()
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        tracing::warn!("report: Telegram answered {status}: {}", sanitize(&body.chars().take(300).collect::<String>()));
        return Err(ERROR_FAILED.to_owned());
    }
    tracing::info!("report: sent");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_removed() {
        let line = "GET http://127.0.0.1:51234/0123456789abcdef0123456789abcdef/stream/x api_key=SECRET&lang=ru pk=abc 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ";
        let clean = sanitize(line);
        assert!(!clean.contains("0123456789abcdef0123456789abcdef"));
        assert!(!clean.contains("SECRET"));
        assert!(!clean.contains("pk=abc"));
        assert!(!clean.contains("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ"));
        assert!(clean.contains("127.0.0.1:51234/<token>/stream/x"));
        assert!(clean.contains("<bot-token>"));
    }

    #[test]
    fn long_logs_keep_the_end() {
        let text = "first line\nsecond line\nthird line\n";
        assert_eq!(tail(text, 15), "third line\n");
        assert_eq!(tail(text, 1000), text);
    }
}
