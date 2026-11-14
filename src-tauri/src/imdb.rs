use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use flate2::read::GzDecoder;
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::AppState;

const RATINGS_URL: &str = "https://datasets.imdbws.com/title.ratings.tsv.gz";
const FOLDER_NAME: &str = "imdb";
const INDEX_FILE_NAME: &str = "ratings.bin";
const MAX_INDEX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(30 * 60);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const RECORD_BYTES: usize = 9;
const RATING_SCALE: f32 = 10.0;

#[derive(Serialize)]
pub struct ImdbRating {
    rating: f32,
    votes: u32,
}

#[derive(Default)]
pub struct ImdbState {
    last_failure: Mutex<Option<SystemTime>>,
}

const MAX_BATCH: usize = 400;

fn numeric_id(imdb_id: &str) -> Option<u32> {
    imdb_id.strip_prefix("tt").and_then(|digits| digits.parse::<u32>().ok())
}

#[tauri::command]
pub async fn imdb_rating(
    app: State<'_, AppState>,
    imdb: State<'_, ImdbState>,
    imdb_id: String,
) -> Result<Option<ImdbRating>, String> {
    let Some(id) = numeric_id(&imdb_id) else {
        return Ok(None);
    };
    let index = fresh_index(&app, &imdb).await;
    tauri::async_runtime::spawn_blocking(move || lookup(&index, id))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn imdb_ratings(
    app: State<'_, AppState>,
    imdb: State<'_, ImdbState>,
    imdb_ids: Vec<String>,
) -> Result<HashMap<String, ImdbRating>, String> {
    let wanted: Vec<(String, u32)> = imdb_ids
        .into_iter()
        .take(MAX_BATCH)
        .filter_map(|imdb_id| numeric_id(&imdb_id).map(|id| (imdb_id, id)))
        .collect();
    if wanted.is_empty() {
        return Ok(HashMap::new());
    }
    let index = fresh_index(&app, &imdb).await;
    tauri::async_runtime::spawn_blocking(move || {
        wanted
            .into_iter()
            .filter_map(|(imdb_id, id)| lookup(&index, id).map(|rating| (imdb_id, rating)))
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

async fn fresh_index(app: &AppState, imdb: &ImdbState) -> PathBuf {
    let index = app.data_dir.join(FOLDER_NAME).join(INDEX_FILE_NAME);
    {
        let mut last_failure = imdb.last_failure.lock().await;
        let failed_recently = last_failure
            .and_then(|at| at.elapsed().ok())
            .is_some_and(|since| since < RETRY_AFTER_FAILURE);
        if is_stale(&index) && !failed_recently {
            match refresh(&index).await {
                Ok(()) => *last_failure = None,
                Err(error) => {
                    tracing::warn!("imdb: refresh failed: {error}");
                    *last_failure = Some(SystemTime::now());
                }
            }
        }
    }
    index
}

fn is_stale(index: &Path) -> bool {
    fs::metadata(index)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_none_or(|age| age > MAX_INDEX_AGE)
}

async fn refresh(index: &Path) -> anyhow::Result<()> {
    let client = reqwest::Client::builder().timeout(DOWNLOAD_TIMEOUT).build()?;
    let archive = client.get(RATINGS_URL).send().await?.error_for_status()?.bytes().await?;

    let index = index.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || write_index(&archive, &index)).await?
}

fn write_index(archive: &[u8], index: &PathBuf) -> anyhow::Result<()> {
    let mut records: Vec<(u32, u8, u32)> = Vec::new();
    for line in BufReader::new(GzDecoder::new(archive)).lines() {
        let line = line?;
        let mut fields = line.split('\t');
        let (Some(id), Some(rating), Some(votes)) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        let (Some(id), Ok(rating), Ok(votes)) = (
            id.strip_prefix("tt").and_then(|digits| digits.parse::<u32>().ok()),
            rating.parse::<f32>(),
            votes.parse::<u32>(),
        ) else {
            continue;
        };
        records.push((id, (rating * RATING_SCALE).round() as u8, votes));
    }
    anyhow::ensure!(!records.is_empty(), "the ratings export is empty");
    records.sort_unstable_by_key(|record| record.0);

    let mut bytes = Vec::with_capacity(records.len() * RECORD_BYTES);
    for (id, rating, votes) in records {
        bytes.extend_from_slice(&id.to_be_bytes());
        bytes.push(rating);
        bytes.extend_from_slice(&votes.to_be_bytes());
    }

    if let Some(parent) = index.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = index.with_extension("bin.tmp");
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, index)?;
    Ok(())
}

fn lookup(index: &Path, id: u32) -> Option<ImdbRating> {
    let mut file = File::open(index).ok()?;
    let count = file.metadata().ok()?.len() / RECORD_BYTES as u64;
    let (mut low, mut high) = (0u64, count);
    let mut record = [0u8; RECORD_BYTES];

    while low < high {
        let middle = low + (high - low) / 2;
        file.seek(SeekFrom::Start(middle * RECORD_BYTES as u64)).ok()?;
        file.read_exact(&mut record).ok()?;
        let found = u32::from_be_bytes([record[0], record[1], record[2], record[3]]);
        match found.cmp(&id) {
            std::cmp::Ordering::Equal => {
                return Some(ImdbRating {
                    rating: f32::from(record[4]) / RATING_SCALE,
                    votes: u32::from_be_bytes([record[5], record[6], record[7], record[8]]),
                });
            }
            std::cmp::Ordering::Less => low = middle + 1,
            std::cmp::Ordering::Greater => high = middle,
        }
    }
    None
}

#[cfg(test)]
mod batch_tests {
    use super::*;

    #[test]
    fn finds_several_ratings_in_one_index() {
        let folder = std::env::temp_dir().join(format!("kinuza-imdb-test-{}", std::process::id()));
        let index = folder.join(INDEX_FILE_NAME);
        let mut archive = Vec::new();
        {
            use std::io::Write;
            let mut encoder = flate2::write::GzEncoder::new(&mut archive, flate2::Compression::fast());
            encoder.write_all(b"tconst\taverageRating\tnumVotes\ntt0000002\t5.6\t300\ntt0816692\t8.7\t2500000\ntt0092991\t7.7\t180000\n").unwrap();
            encoder.finish().unwrap();
        }
        write_index(&archive, &index).unwrap();
        assert_eq!(lookup(&index, 816692).map(|rating| rating.rating), Some(8.7));
        assert_eq!(lookup(&index, 92991).map(|rating| rating.votes), Some(180000));
        assert!(lookup(&index, 1).is_none());
        assert_eq!(numeric_id("tt0092991"), Some(92991));
        assert_eq!(numeric_id("0092991"), None);
        let _ = fs::remove_dir_all(&folder);
    }
}
