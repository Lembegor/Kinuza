use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

const WIKIDATA_URL: &str = "https://query.wikidata.org/sparql";
const WIKIDATA_AGENT: &str = "Kinuza (https://github.com/Lembegor/Kinuza)";
const SHIKIMORI_URL: &str = "https://shikimori.io/api/animes";
const SHIKIMORI_AGENT: &str = "Kinuza";
const SHIKIMORI_GAP: Duration = Duration::from_millis(700);
const SHIKIMORI_RETRY_DELAY: Duration = Duration::from_millis(1500);
const SHIKIMORI_BATCH: usize = 50;
const SHIKIMORI_SEARCH_LIMIT: &str = "12";
const SEARCH_MIN_CHARS: usize = 3;
const WIKIDATA_BATCH: usize = 40;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const TAG_MAX_LENGTH: usize = 80;
const ERROR_UNAVAILABLE: &str = "metadata_unavailable";

static SHIKIMORI_LAST: Mutex<Option<Instant>> = Mutex::const_new(None);

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TitleLinks {
    mal: Option<u64>,
    anilist: Option<u64>,
    ru: Option<String>,
    uk: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShikimoriAnime {
    id: u64,
    russian: String,
    description: String,
    names: Vec<String>,
    genres: Vec<AnimeGenre>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnimeGenre {
    #[serde(default)]
    name: String,
    #[serde(default)]
    russian: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShikimoriName {
    id: u64,
    russian: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShikimoriFound {
    id: u64,
    russian: String,
    name: String,
    kind: String,
    year: Option<u32>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MalLink {
    mal: u64,
    kind: String,
    tmdb_id: u64,
}

#[derive(Deserialize)]
struct RawFound {
    id: u64,
    #[serde(default)]
    russian: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    aired_on: Option<String>,
}

#[derive(Deserialize)]
struct RawAnime {
    id: u64,
    #[serde(default)]
    russian: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    english: Value,
    #[serde(default)]
    japanese: Value,
    #[serde(default)]
    genres: Value,
}

fn strings_of(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) => vec![text.clone()],
        Value::Array(items) => items.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        _ => Vec::new(),
    }
}

fn client(agent: &str) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(agent)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| ERROR_UNAVAILABLE.to_owned())
}

fn has_cyrillic(text: &str) -> bool {
    text.chars().any(|letter| matches!(letter, '\u{0400}'..='\u{04FF}'))
}

fn clean_label(label: &str) -> Option<String> {
    let mut text = label.trim();
    if text.ends_with(')') {
        if let Some(start) = text.rfind('(') {
            text = text[..start].trim_end();
        }
    }
    (!text.is_empty() && has_cyrillic(text)).then(|| text.to_owned())
}

fn is_markup(inner: &str) -> bool {
    let name = inner.strip_prefix('/').unwrap_or(inner);
    let name = name.split('=').next().unwrap_or("");
    !name.is_empty() && name.chars().all(|letter| letter.is_ascii_lowercase() || letter == '_')
}

fn is_japanese_note(inner: &str) -> bool {
    let mut has_japanese = false;
    for letter in inner.chars() {
        match letter as u32 {
            0x3000..=0x30FF | 0x31F0..=0x31FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xFF00..=0xFFEF => has_japanese = true,
            0x20 | 0xB7 => {}
            _ => return false,
        }
    }
    has_japanese
}

pub(crate) fn clean_description(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        plain.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        if let Some(link) = after.strip_prefix('[') {
            if let Some(close) = link.find("]]").filter(|close| *close <= TAG_MAX_LENGTH) {
                plain.push_str(&link[..close]);
                rest = &link[close + 2..];
                continue;
            }
        }
        match after.find(']') {
            Some(close) if close <= TAG_MAX_LENGTH && is_markup(&after[..close]) => rest = &after[close + 1..],
            Some(close) if close <= TAG_MAX_LENGTH && is_japanese_note(&after[..close]) => {
                let kept = plain.trim_end_matches(' ').len();
                plain.truncate(kept);
                rest = &after[close + 1..];
            }
            _ => {
                plain.push('[');
                rest = after;
            }
        }
    }
    plain.push_str(rest);
    let lines: Vec<String> = plain
        .replace("\r\n", "\n")
        .split('\n')
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect();
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in lines {
        if line.is_empty() {
            if !current.is_empty() {
                paragraphs.push(std::mem::take(&mut current));
            }
        } else {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(&line);
        }
    }
    if !current.is_empty() {
        paragraphs.push(current);
    }
    paragraphs.join("\n\n")
}

fn wikidata_query(kind: &str, tmdb_id: u64) -> Option<String> {
    let property = match kind {
        "movie" => "P4947",
        "tv" => "P4983",
        _ => return None,
    };
    Some(format!(
        "SELECT ?mal ?anilist ?ru ?uk WHERE {{ ?item wdt:{property} \"{tmdb_id}\" . \
         OPTIONAL {{ ?item wdt:P4086 ?mal }} OPTIONAL {{ ?item wdt:P8729 ?anilist }} \
         OPTIONAL {{ ?item rdfs:label ?ru FILTER(LANG(?ru) = \"ru\") }} \
         OPTIONAL {{ ?item rdfs:label ?uk FILTER(LANG(?uk) = \"uk\") }} }} LIMIT 10"
    ))
}

fn binding<'a>(row: &'a Value, name: &str) -> Option<&'a str> {
    row.get(name)?.get("value")?.as_str()
}

fn parse_links(body: &Value) -> Option<TitleLinks> {
    let rows = body.get("results")?.get("bindings")?.as_array()?;
    if rows.is_empty() {
        return None;
    }
    let mut links = TitleLinks::default();
    for row in rows {
        let mal: Option<u64> = binding(row, "mal").and_then(|value| value.trim().parse().ok());
        let anilist: Option<u64> = binding(row, "anilist").and_then(|value| value.trim().parse().ok());
        links.mal = match (links.mal, mal) {
            (Some(known), Some(found)) => Some(known.min(found)),
            (known, found) => known.or(found),
        };
        links.anilist = match (links.anilist, anilist) {
            (Some(known), Some(found)) => Some(known.min(found)),
            (known, found) => known.or(found),
        };
        links.ru = links.ru.take().or_else(|| binding(row, "ru").and_then(clean_label));
        links.uk = links.uk.take().or_else(|| binding(row, "uk").and_then(clean_label));
    }
    Some(links)
}

#[tauri::command]
pub async fn wikidata_links(kind: String, tmdb_id: u64) -> Result<Option<TitleLinks>, String> {
    let Some(query) = wikidata_query(&kind, tmdb_id) else {
        return Ok(None);
    };
    let response = client(WIKIDATA_AGENT)?
        .get(WIKIDATA_URL)
        .query(&[("query", query.as_str()), ("format", "json")])
        .header(reqwest::header::ACCEPT, "application/sparql-results+json")
        .send()
        .await
        .map_err(|_| ERROR_UNAVAILABLE.to_owned())?;
    if !response.status().is_success() {
        tracing::warn!("wikidata: status {}", response.status());
        return Err(ERROR_UNAVAILABLE.to_owned());
    }
    let body: Value = response.json().await.map_err(|_| ERROR_UNAVAILABLE.to_owned())?;
    Ok(parse_links(&body))
}

async fn shikimori_get(path: &str) -> Result<Option<Value>, String> {
    shikimori_request(path, &[]).await
}

async fn shikimori_request(path: &str, params: &[(&str, &str)]) -> Result<Option<Value>, String> {
    let url = reqwest::Url::parse_with_params(&format!("{SHIKIMORI_URL}{path}"), params).map_err(|_| ERROR_UNAVAILABLE.to_owned())?;
    let client = client(SHIKIMORI_AGENT)?;
    for attempt in 0..2 {
        {
            let mut last = SHIKIMORI_LAST.lock().await;
            if let Some(previous) = *last {
                let wait = SHIKIMORI_GAP.saturating_sub(previous.elapsed());
                if !wait.is_zero() {
                    tokio::time::sleep(wait).await;
                }
            }
            *last = Some(Instant::now());
        }
        let response = client.get(url.clone()).send().await.map_err(|_| ERROR_UNAVAILABLE.to_owned())?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS && attempt == 0 {
            tokio::time::sleep(SHIKIMORI_RETRY_DELAY).await;
            continue;
        }
        if !status.is_success() {
            tracing::warn!("shikimori: status {status}");
            return Err(ERROR_UNAVAILABLE.to_owned());
        }
        return response.json().await.map(Some).map_err(|_| ERROR_UNAVAILABLE.to_owned());
    }
    Err(ERROR_UNAVAILABLE.to_owned())
}

fn to_anime(raw: RawAnime) -> ShikimoriAnime {
    let names = raw
        .name
        .iter()
        .cloned()
        .chain(strings_of(&raw.japanese))
        .chain(strings_of(&raw.english))
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    let genres = raw
        .genres
        .as_array()
        .map(|items| items.iter().filter_map(|item| serde_json::from_value::<AnimeGenre>(item.clone()).ok()).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|genre| !genre.name.trim().is_empty())
        .collect();
    ShikimoriAnime {
        names,
        genres,
        id: raw.id,
        russian: raw.russian.map(|name| name.trim().to_owned()).filter(|name| has_cyrillic(name)).unwrap_or_default(),
        description: raw.description.map(|text| clean_description(&text)).unwrap_or_default(),
    }
}

#[tauri::command]
pub async fn shikimori_anime(id: u64) -> Result<Option<ShikimoriAnime>, String> {
    let Some(body) = shikimori_get(&format!("/{id}")).await? else {
        return Ok(None);
    };
    Ok(serde_json::from_value::<RawAnime>(body).ok().map(to_anime))
}

#[tauri::command]
pub async fn shikimori_names(ids: Vec<u64>) -> Result<Vec<ShikimoriName>, String> {
    let mut names = Vec::new();
    let mut unique = ids;
    unique.sort_unstable();
    unique.dedup();
    for chunk in unique.chunks(SHIKIMORI_BATCH) {
        let list = chunk.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
        let Some(body) = shikimori_get(&format!("?ids={list}&limit={SHIKIMORI_BATCH}")).await? else {
            continue;
        };
        let rows: Vec<RawAnime> = serde_json::from_value(body).unwrap_or_default();
        names.extend(rows.into_iter().map(to_anime).filter(|anime| !anime.russian.is_empty()).map(|anime| ShikimoriName { id: anime.id, russian: anime.russian }));
    }
    Ok(names)
}

fn to_found(raw: RawFound) -> ShikimoriFound {
    ShikimoriFound {
        id: raw.id,
        russian: raw.russian.map(|name| name.trim().to_owned()).filter(|name| has_cyrillic(name)).unwrap_or_default(),
        name: raw.name.map(|name| name.trim().to_owned()).unwrap_or_default(),
        kind: raw.kind.unwrap_or_default(),
        year: raw.aired_on.as_deref().and_then(|date| date.get(..4)).and_then(|year| year.parse().ok()),
    }
}

#[tauri::command]
pub async fn shikimori_search(query: String) -> Result<Vec<ShikimoriFound>, String> {
    let query = query.trim();
    if query.chars().count() < SEARCH_MIN_CHARS {
        return Ok(Vec::new());
    }
    let Some(body) = shikimori_request("", &[("search", query), ("limit", SHIKIMORI_SEARCH_LIMIT)]).await? else {
        return Ok(Vec::new());
    };
    let rows: Vec<RawFound> = serde_json::from_value(body).unwrap_or_default();
    Ok(rows.into_iter().map(to_found).collect())
}

fn mal_query(ids: &[u64]) -> String {
    let values = ids.iter().map(|id| format!("\"{id}\"")).collect::<Vec<_>>().join(" ");
    format!(
        "SELECT ?mal ?tv ?movie WHERE {{ VALUES ?mal {{ {values} }} ?item wdt:P4086 ?mal .          OPTIONAL {{ ?item wdt:P4983 ?tv }} OPTIONAL {{ ?item wdt:P4947 ?movie }} }}"
    )
}

fn parse_mal_links(body: &Value) -> Vec<MalLink> {
    let Some(rows) = body.get("results").and_then(|results| results.get("bindings")).and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut links: Vec<MalLink> = Vec::new();
    for row in rows {
        let Some(mal) = binding(row, "mal").and_then(|value| value.trim().parse().ok()) else {
            continue;
        };
        for (kind, name) in [("tv", "tv"), ("movie", "movie")] {
            let Some(tmdb_id) = binding(row, name).and_then(|value| value.trim().parse().ok()) else {
                continue;
            };
            let link = MalLink { mal, kind: kind.to_owned(), tmdb_id };
            if !links.contains(&link) {
                links.push(link);
            }
        }
    }
    links
}

#[tauri::command]
pub async fn wikidata_by_mal(ids: Vec<u64>) -> Result<Vec<MalLink>, String> {
    let mut unique = ids;
    unique.sort_unstable();
    unique.dedup();
    let mut links = Vec::new();
    let client = client(WIKIDATA_AGENT)?;
    for chunk in unique.chunks(WIKIDATA_BATCH) {
        let query = mal_query(chunk);
        let response = client
            .get(WIKIDATA_URL)
            .query(&[("query", query.as_str()), ("format", "json")])
            .header(reqwest::header::ACCEPT, "application/sparql-results+json")
            .send()
            .await
            .map_err(|_| ERROR_UNAVAILABLE.to_owned())?;
        if !response.status().is_success() {
            tracing::warn!("wikidata: status {}", response.status());
            return Err(ERROR_UNAVAILABLE.to_owned());
        }
        let body: Value = response.json().await.map_err(|_| ERROR_UNAVAILABLE.to_owned())?;
        links.extend(parse_mal_links(&body));
    }
    Ok(links)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_is_removed_and_text_is_kept() {
        let text = "Ремейк аниме «[anime=121]Стальной алхимик[/anime]» про [character=11]Эдварда[/character].\r\n\r\n[i]Второй[/i]   абзац.";
        assert_eq!(clean_description(text), "Ремейк аниме «Стальной алхимик» про Эдварда.\n\nВторой абзац.");
    }

    #[test]
    fn wiki_links_and_japanese_notes_are_cleaned() {
        let text = "Джонатан Джостар, он же [[ДжоДжо]], и Люси [ルーシー] - героиня. Дио [ディオ・ブランドー].";
        assert_eq!(clean_description(text), "Джонатан Джостар, он же ДжоДжо, и Люси - героиня. Дио.");
        assert_eq!(clean_description("Сезон [2]"), "Сезон [2]");
        assert_eq!(clean_description("Незакрытая [[ссылка"), "Незакрытая [[ссылка");
    }

    #[test]
    fn brackets_that_are_not_markup_stay() {
        assert_eq!(clean_description("Глава [1] и [Примечание автора]"), "Глава [1] и [Примечание автора]");
        assert_eq!(clean_description("Незакрытая [скобка"), "Незакрытая [скобка");
    }

    #[test]
    fn labels_without_cyrillic_are_rejected() {
        assert_eq!(clean_label("Attack on Titan (аніме)"), None);
        assert_eq!(clean_label("Атака титанов (аниме)"), Some("Атака титанов".to_owned()));
        assert_eq!(clean_label("Наруто: Ураганные хроники"), Some("Наруто: Ураганные хроники".to_owned()));
        assert_eq!(clean_label("   "), None);
    }

    #[test]
    fn links_merge_across_rows() {
        let body = serde_json::json!({ "results": { "bindings": [
            { "mal": { "value": "16498" }, "ru": { "value": "Атака титанов" } },
            { "anilist": { "value": "16498" }, "uk": { "value": "Attack on Titan (аніме)" } }
        ] } });
        assert_eq!(
            parse_links(&body),
            Some(TitleLinks { mal: Some(16498), anilist: Some(16498), ru: Some("Атака титанов".to_owned()), uk: None })
        );
        assert_eq!(parse_links(&serde_json::json!({ "results": { "bindings": [] } })), None);
        assert_eq!(parse_links(&serde_json::json!({ "error": "x" })), None);
    }

    #[test]
    fn mal_links_cover_series_and_films() {
        let body = serde_json::json!({ "results": { "bindings": [
            { "mal": { "value": "16498" }, "tv": { "value": "1429" } },
            { "mal": { "value": "16498" }, "tv": { "value": "1429" } },
            { "mal": { "value": "32281" }, "movie": { "value": "372058" } },
            { "mal": { "value": "1" } },
            { "mal": { "value": "bad" }, "tv": { "value": "5" } }
        ] } });
        assert_eq!(
            parse_mal_links(&body),
            vec![
                MalLink { mal: 16498, kind: "tv".to_owned(), tmdb_id: 1429 },
                MalLink { mal: 32281, kind: "movie".to_owned(), tmdb_id: 372058 },
            ]
        );
        assert!(parse_mal_links(&serde_json::json!({})).is_empty());
        assert!(mal_query(&[1, 2]).contains("VALUES ?mal { \"1\" \"2\" }"));
    }

    #[test]
    fn found_entries_keep_only_cyrillic_russian() {
        let found = to_found(RawFound { id: 5, russian: Some("Bleach".to_owned()), name: Some(" Bleach ".to_owned()), kind: Some("tv".to_owned()), aired_on: Some("2004-10-05".to_owned()) });
        assert_eq!(found, ShikimoriFound { id: 5, russian: String::new(), name: "Bleach".to_owned(), kind: "tv".to_owned(), year: Some(2004) });
        assert_eq!(to_found(RawFound { id: 6, russian: None, name: None, kind: None, aired_on: Some("bad".to_owned()) }).year, None);
    }

    #[test]
    fn earliest_ids_win_when_an_item_has_several() {
        let body = serde_json::json!({ "results": { "bindings": [
            { "mal": { "value": "38524" }, "anilist": { "value": "104578" } },
            { "mal": { "value": "16498" }, "anilist": { "value": "16498" } }
        ] } });
        let links = parse_links(&body).unwrap();
        assert_eq!((links.mal, links.anilist), (Some(16498), Some(16498)));
    }

    #[test]
    fn unknown_kind_builds_no_query() {
        assert!(wikidata_query("person", 1).is_none());
        assert!(wikidata_query("tv", 1429).unwrap().contains("wdt:P4983 \"1429\""));
    }

    #[tokio::test]
    #[ignore = "needs network"]
    async fn live_chain_from_tmdb_to_shikimori() {
        let links = wikidata_links("tv".to_owned(), 1429).await.unwrap().unwrap();
        assert_eq!(links.mal, Some(16498));
        assert!(links.ru.as_deref().is_some_and(has_cyrillic));
        let anime = shikimori_anime(16498).await.unwrap().unwrap();
        assert!(has_cyrillic(&anime.russian));
        assert!(anime.names.iter().any(|name| name == "進撃の巨人"));
        assert!(anime.genres.iter().any(|genre| genre.name == "Action"));
        assert!(anime.description.len() > 50 && !anime.description.contains("[/"));
        let names = shikimori_names(vec![16498, 5114, 16498]).await.unwrap();
        assert_eq!(names.len(), 2);
        assert!(shikimori_anime(999_999_999).await.unwrap().is_none());
        assert!(wikidata_links("movie".to_owned(), 999_999_999).await.unwrap().is_none());
        let found = shikimori_search("Атака титанов".to_owned()).await.unwrap();
        assert!(found.iter().any(|anime| anime.id == 16498));
        assert!(shikimori_search("ab".to_owned()).await.unwrap().is_empty());
        let links = wikidata_by_mal(vec![16498, 32281]).await.unwrap();
        assert!(links.contains(&MalLink { mal: 16498, kind: "tv".to_owned(), tmdb_id: 1429 }));
        assert!(links.iter().any(|link| link.mal == 32281 && link.kind == "movie"));
    }

    #[test]
    fn russian_name_must_be_cyrillic() {
        let anime = to_anime(RawAnime { id: 1, russian: Some("Naruto".to_owned()), description: None, name: None, english: Value::Null, japanese: Value::Null, genres: Value::Null });
        assert_eq!(anime.russian, "");
        assert_eq!(anime.description, "");
        assert!(anime.names.is_empty());
        assert!(anime.genres.is_empty());
    }

    #[test]
    fn genres_are_read() {
        let raw: RawAnime = serde_json::from_value(serde_json::json!({
            "id": 226, "genres": [{ "id": 42, "name": "Seinen", "russian": "Сэйнэн", "kind": "genre" }, { "name": "" }, 5]
        }))
        .unwrap();
        assert_eq!(to_anime(raw).genres, vec![AnimeGenre { name: "Seinen".to_owned(), russian: "Сэйнэн".to_owned() }]);
    }

    #[test]
    fn all_original_names_are_collected() {
        let raw: RawAnime = serde_json::from_value(serde_json::json!({
            "id": 16498, "russian": "Атака титанов", "name": "Shingeki no Kyojin",
            "english": ["Attack on Titan", null], "japanese": ["進撃の巨人"], "description": null
        }))
        .unwrap();
        assert_eq!(to_anime(raw).names, vec!["Shingeki no Kyojin", "進撃の巨人", "Attack on Titan"]);
    }
}
