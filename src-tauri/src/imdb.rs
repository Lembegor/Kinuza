//! IMDb ratings from IMDb's own daily export (https://developer.imdb.com/non-commercial-datasets/).
//! The export is one gzipped table of every rated title. It is downloaded about once a week,
//! turned into a compact sorted file, and looked up there, so showing a rating needs no network.
//! IMDb allows the export for personal and non-commercial use only.

use std::{
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
/// Ratings move slowly; a week-old copy is as good as a fresh one.
const MAX_INDEX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// After a failed download the old copy (or nothing) is served for this long before trying again.
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(30 * 60);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// One title: numeric id (4 bytes), rating times ten (1 byte), vote count (4 bytes), big-endian.
const RECORD_BYTES: usize = 9;
const RATING_SCALE: f32 = 10.0;

#[derive(Serialize)]
pub struct ImdbRating {
    rating: f32,
    votes: u32,
}

/// Serialises refreshes and remembers a failed one, so a title page does not start a download per visit.
#[derive(Default)]
pub struct ImdbState {
    last_failure: Mutex<Option<SystemTime>>,
}

/// `imdb_id` is the usual "tt1375666". Returns `None` for a title IMDb has no rating for.
#[tauri::command]
pub async fn imdb_rating(
    app: State<'_, AppState>,
    imdb: State<'_, ImdbState>,
    imdb_id: String,
) -> Result<Option<ImdbRating>, String> {
    let Some(id) = imdb_id.strip_prefix("tt").and_then(|digits| digits.parse::<u32>().ok()) else {
        return Ok(None);
    };
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

    tauri::async_runtime::spawn_blocking(move || lookup(&index, id))
        .await
        .map_err(|e| e.to_string())
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

/// Parses the gzipped table and replaces the index file atomically.
fn write_index(archive: &[u8], index: &PathBuf) -> anyhow::Result<()> {
    let mut records: Vec<(u32, u8, u32)> = Vec::new();
    // The first line is the header "tconst averageRating numVotes"; it fails to parse and is skipped like any bad line.
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

/// Binary search over the fixed-size records on disk.
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
