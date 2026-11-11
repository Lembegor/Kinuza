use std::path::Path;

use serde::Serialize;

pub const LAUNCH_EVENT: &str = "launch-request";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub kind: &'static str,
    pub value: String,
}

pub fn from_args<I>(args: I) -> Option<LaunchRequest>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter().find_map(|argument| {
        let lower = argument.to_ascii_lowercase();
        if lower.starts_with("magnet:?") {
            return Some(LaunchRequest {
                kind: "magnet",
                value: argument,
            });
        }
        let path = if lower.starts_with("file://") {
            tauri::Url::parse(&argument).ok()?.to_file_path().ok()?.to_string_lossy().into_owned()
        } else {
            argument
        };
        if path.to_ascii_lowercase().ends_with(".torrent") && Path::new(&path).is_file() {
            return Some(LaunchRequest {
                kind: "file",
                value: path,
            });
        }
        None
    })
}
