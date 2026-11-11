//! A magnet link or .torrent file handed to the app by Windows on the command line.

use std::path::Path;

use serde::Serialize;

/// Event sent to the window when a second launch forwards a link to the running app.
pub const LAUNCH_EVENT: &str = "launch-request";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    /// "magnet" or "file".
    pub kind: &'static str,
    pub value: String,
}

/// Finds the first argument that is a magnet link or an existing .torrent file.
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
        if lower.ends_with(".torrent") && Path::new(&argument).is_file() {
            return Some(LaunchRequest {
                kind: "file",
                value: argument,
            });
        }
        None
    })
}
