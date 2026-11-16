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
        if lower.starts_with(&format!("{}://", crate::share_links::SCHEME)) {
            return friend_link(&argument)
                .map(|value| LaunchRequest { kind: "friend", value })
                .or_else(|| title_link(&argument).map(|value| LaunchRequest { kind: "title", value }));
        }
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

fn friend_link(argument: &str) -> Option<String> {
    let url = tauri::Url::parse(argument).ok()?;
    if url.host_str()? != "friend" {
        return None;
    }
    let code = url.path().trim_matches('/');
    let valid = (6..=12).contains(&code.len()) && code.chars().all(|c| c.is_ascii_alphanumeric());
    valid.then(|| code.to_ascii_uppercase())
}

fn title_link(argument: &str) -> Option<String> {
    let url = tauri::Url::parse(argument).ok()?;
    if url.host_str()? != "title" {
        return None;
    }
    let parts: Vec<&str> = url.path().trim_matches('/').split('/').collect();
    let [kind, id] = parts.as_slice() else { return None };
    if !matches!(*kind, "movie" | "tv") || id.is_empty() || id.len() > 10 || !id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let mut value = format!("{kind}/{id}");
    if *kind == "tv" {
        let number = |name: &str| {
            url.query_pairs()
                .find(|(key, _)| key == name)
                .and_then(|(_, found)| found.parse::<u32>().ok())
                .filter(|found| *found < 10_000)
        };
        if let Some(season) = number("s") {
            value.push_str(&format!("?s={season}"));
            if let Some(episode) = number("e") {
                value.push_str(&format!("&e={episode}"));
            }
        }
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_links_are_read_and_checked() {
        let read = |text: &str| from_args([text.to_owned()]).map(|request| (request.kind, request.value));
        assert_eq!(read("kinuza://title/movie/1300968"), Some(("title", "movie/1300968".to_owned())));
        assert_eq!(read("kinuza://title/tv/45790?s=2&e=7"), Some(("title", "tv/45790?s=2&e=7".to_owned())));
        assert_eq!(read("kinuza://title/tv/45790/"), Some(("title", "tv/45790".to_owned())));
        assert_eq!(read("kinuza://title/person/1"), None);
        assert_eq!(read("kinuza://title/movie/12a"), None);
        assert_eq!(read("kinuza://evil/movie/1"), None);
        assert_eq!(read("kinuza://title/movie/1/2"), None);
        assert_eq!(read("kinuza://friend/abcd2345"), Some(("friend", "ABCD2345".to_owned())));
        assert_eq!(read("kinuza://friend/ab"), None);
        assert_eq!(read("kinuza://friend/abcd-2345"), None);
    }
}
