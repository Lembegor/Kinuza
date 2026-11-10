//! Torrent engine: a thin layer over a librqbit session that speaks in info hashes and plain DTOs.

use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use librqbit::{
    api::TorrentIdOrHash, dht::Id20, AddTorrent, AddTorrentOptions, AddTorrentResponse,
    ListenerOptions, ManagedTorrent, Session, SessionOptions, SessionPersistenceConfig,
    TorrentStatsState,
};
use serde::Serialize;

/// How long a magnet link may take to resolve its metadata before we give up.
const METADATA_TIMEOUT: Duration = Duration::from_secs(90);
const BYTES_PER_MEBIBYTE: f64 = 1024.0 * 1024.0;

type TorrentHandle = Arc<ManagedTorrent>;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TorrentFileView {
    pub index: usize,
    pub path: String,
    pub length: u64,
    pub included: bool,
    pub downloaded: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TorrentPreview {
    pub info_hash: String,
    pub name: String,
    pub files: Vec<TorrentFileView>,
    pub already_added: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TorrentView {
    pub info_hash: String,
    pub name: String,
    pub output_folder: String,
    pub state: &'static str,
    pub error: Option<String>,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    pub uploaded_bytes: u64,
    pub finished: bool,
    pub download_speed: f64,
    pub upload_speed: f64,
    pub peers: u64,
    pub files: Vec<TorrentFileView>,
}

/// Metadata resolved by `inspect` and kept until the user confirms the add.
struct PendingTorrent {
    torrent_bytes: Bytes,
    seen_peers: Vec<SocketAddr>,
    name: String,
    file_count: usize,
}

pub struct Engine {
    session: Arc<Session>,
    pending: Mutex<HashMap<String, PendingTorrent>>,
}

impl Engine {
    pub async fn start(default_output: PathBuf, persistence_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&default_output).ok();
        std::fs::create_dir_all(&persistence_dir).ok();

        let options = SessionOptions {
            fastresume: true,
            persistence: Some(SessionPersistenceConfig::Json {
                folder: Some(persistence_dir),
            }),
            listen: Some(ListenerOptions {
                enable_upnp_port_forwarding: true,
                ..Default::default()
            }),
            ..Default::default()
        };
        let session = Session::new_with_opts(default_output, options)
            .await
            .context("failed to start the torrent session")?;

        Ok(Self {
            session,
            pending: Mutex::new(HashMap::new()),
        })
    }

    /// Resolves a magnet link or .torrent contents into a file list without starting the download.
    pub async fn inspect(&self, source: AddTorrent<'static>) -> Result<TorrentPreview> {
        let options = AddTorrentOptions {
            list_only: true,
            ..Default::default()
        };
        let response = tokio::time::timeout(
            METADATA_TIMEOUT,
            self.session.add_torrent(source, Some(options)),
        )
        .await
        .map_err(|_| anyhow!("metadata_timeout"))??;

        match response {
            AddTorrentResponse::ListOnly(listed) => {
                let info_hash = listed.info_hash.as_string();
                let name = listed
                    .info
                    .name()
                    .map(|n| n.into_owned())
                    .unwrap_or_else(|| info_hash.clone());
                let files: Vec<TorrentFileView> = listed
                    .info
                    .iter_file_details()
                    .enumerate()
                    .map(|(index, details)| TorrentFileView {
                        index,
                        path: details.filename.to_vec().join("/"),
                        length: details.len,
                        included: true,
                        downloaded: 0,
                    })
                    .collect();

                let already_added = self.find(&info_hash).is_ok();
                self.pending.lock().unwrap().insert(
                    info_hash.clone(),
                    PendingTorrent {
                        torrent_bytes: listed.torrent_bytes,
                        seen_peers: listed.seen_peers,
                        name: name.clone(),
                        file_count: files.len(),
                    },
                );
                Ok(TorrentPreview {
                    info_hash,
                    name,
                    files,
                    already_added,
                })
            }
            AddTorrentResponse::AlreadyManaged(_, handle) | AddTorrentResponse::Added(_, handle) => {
                Ok(TorrentPreview {
                    info_hash: handle.info_hash().as_string(),
                    name: display_name(&handle),
                    files: file_views(&handle, &[]),
                    already_added: true,
                })
            }
        }
    }

    /// Starts downloading the given files of a previously inspected torrent.
    pub async fn add(&self, info_hash: &str, files: Vec<usize>, download_dir: &Path) -> Result<()> {
        if let Ok(handle) = self.find(info_hash) {
            self.pending.lock().unwrap().remove(info_hash);
            self.include_files(&handle, &files).await?;
            return self.resume_handle(&handle).await;
        }

        let pending = self
            .pending
            .lock()
            .unwrap()
            .remove(info_hash)
            .ok_or_else(|| anyhow!("torrent_not_inspected"))?;

        let output_folder = if pending.file_count > 1 {
            download_dir.join(sanitize_folder_name(&pending.name))
        } else {
            download_dir.to_path_buf()
        };
        let options = AddTorrentOptions {
            only_files: Some(files),
            overwrite: true,
            output_folder: Some(output_folder.to_string_lossy().into_owned()),
            initial_peers: Some(pending.seen_peers),
            ..Default::default()
        };
        self.session
            .add_torrent(AddTorrent::from_bytes(pending.torrent_bytes), Some(options))
            .await?;
        Ok(())
    }

    pub fn list(&self) -> Vec<TorrentView> {
        self.session
            .with_torrents(|torrents| torrents.map(|(_, handle)| torrent_view(handle)).collect())
    }

    pub async fn pause(&self, info_hash: &str) -> Result<()> {
        let handle = self.find(info_hash)?;
        if handle.is_paused() {
            return Ok(());
        }
        self.session.pause(&handle).await
    }

    pub async fn resume(&self, info_hash: &str) -> Result<()> {
        let handle = self.find(info_hash)?;
        self.resume_handle(&handle).await
    }

    pub async fn delete(&self, info_hash: &str, delete_files: bool) -> Result<()> {
        let id = parse_hash(info_hash)?;
        self.session
            .delete(TorrentIdOrHash::Hash(id), delete_files)
            .await
    }

    /// Adds files to the download selection (never removes any).
    pub async fn select_files(&self, info_hash: &str, files: &[usize]) -> Result<()> {
        let handle = self.find(info_hash)?;
        self.include_files(&handle, files).await
    }

    /// Makes sure the file is being downloaded and returns the torrent, ready for `stream`.
    pub async fn prepare_stream(&self, info_hash: &str, file_index: usize) -> Result<TorrentHandle> {
        let handle = self.find(info_hash)?;
        self.include_files(&handle, &[file_index]).await?;
        self.resume_handle(&handle).await?;
        Ok(handle)
    }

    pub fn file_path(&self, info_hash: &str, file_index: usize) -> Result<PathBuf> {
        let handle = self.find(info_hash)?;
        let relative = handle
            .with_metadata(|metadata| {
                metadata
                    .file_infos
                    .get(file_index)
                    .map(|file| file.relative_filename.clone())
            })?
            .ok_or_else(|| anyhow!("file_not_found"))?;
        Ok(handle.output_folder().join(relative))
    }

    pub fn file_name(&self, info_hash: &str, file_index: usize) -> Result<String> {
        let path = self.file_path(info_hash, file_index)?;
        Ok(path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default())
    }

    pub fn is_file_complete(&self, info_hash: &str, file_index: usize) -> bool {
        let Ok(handle) = self.find(info_hash) else {
            return false;
        };
        let stats = handle.stats();
        let length = handle
            .with_metadata(|metadata| metadata.file_infos.get(file_index).map(|file| file.len))
            .ok()
            .flatten();
        match (stats.file_progress.get(file_index), length) {
            (Some(have), Some(length)) => *have >= length,
            _ => false,
        }
    }

    fn find(&self, info_hash: &str) -> Result<TorrentHandle> {
        let id = parse_hash(info_hash)?;
        self.session
            .get(TorrentIdOrHash::Hash(id))
            .ok_or_else(|| anyhow!("torrent_not_found"))
    }

    async fn include_files(&self, handle: &TorrentHandle, files: &[usize]) -> Result<()> {
        // `None` means every file is already selected.
        let Some(current) = handle.only_files() else {
            return Ok(());
        };
        let mut selected: HashSet<usize> = current.into_iter().collect();
        let before = selected.len();
        selected.extend(files.iter().copied());
        if selected.len() == before {
            return Ok(());
        }
        self.session.update_only_files(handle, &selected).await
    }

    async fn resume_handle(&self, handle: &TorrentHandle) -> Result<()> {
        if !handle.is_paused() {
            return Ok(());
        }
        self.session.unpause(handle).await
    }
}

fn parse_hash(info_hash: &str) -> Result<Id20> {
    Id20::from_str(info_hash).map_err(|_| anyhow!("bad_info_hash"))
}

fn display_name(handle: &TorrentHandle) -> String {
    handle
        .name()
        .unwrap_or_else(|| handle.info_hash().as_string())
}

fn file_views(handle: &TorrentHandle, file_progress: &[u64]) -> Vec<TorrentFileView> {
    let only_files = handle.only_files();
    handle
        .with_metadata(|metadata| {
            metadata
                .file_infos
                .iter()
                .enumerate()
                .map(|(index, file)| TorrentFileView {
                    index,
                    path: file.relative_filename.to_string_lossy().replace('\\', "/"),
                    length: file.len,
                    included: only_files
                        .as_ref()
                        .map(|selected| selected.contains(&index))
                        .unwrap_or(true),
                    downloaded: file_progress.get(index).copied().unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn torrent_view(handle: &TorrentHandle) -> TorrentView {
    let stats = handle.stats();
    let state = match stats.state {
        TorrentStatsState::Initializing { .. } => "initializing",
        TorrentStatsState::Live => "live",
        TorrentStatsState::Paused => "paused",
        TorrentStatsState::Error => "error",
    };
    let (download_speed, upload_speed, peers) = match &stats.live {
        Some(live) => (
            live.download_speed.mbps * BYTES_PER_MEBIBYTE,
            live.upload_speed.mbps * BYTES_PER_MEBIBYTE,
            live_peer_count(&live.snapshot.peer_stats),
        ),
        None => (0.0, 0.0, 0),
    };

    TorrentView {
        info_hash: handle.info_hash().as_string(),
        name: display_name(handle),
        output_folder: handle.output_folder().to_string_lossy().into_owned(),
        state,
        error: stats.error.clone(),
        progress_bytes: stats.progress_bytes,
        total_bytes: stats.total_bytes,
        uploaded_bytes: stats.uploaded_bytes,
        finished: stats.finished,
        download_speed,
        upload_speed,
        peers,
        files: file_views(handle, &stats.file_progress),
    }
}

/// The peer stats type is not exported by librqbit, so its `live` counter is read through serde.
fn live_peer_count(peer_stats: &impl Serialize) -> u64 {
    serde_json::to_value(peer_stats)
        .ok()
        .and_then(|value| value.get("live").and_then(|live| live.as_u64()))
        .unwrap_or(0)
}

fn sanitize_folder_name(name: &str) -> String {
    const FORBIDDEN_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let cleaned: String = name
        .chars()
        .map(|c| if FORBIDDEN_CHARS.contains(&c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.');
    if trimmed.is_empty() {
        "torrent".to_owned()
    } else {
        trimmed.to_owned()
    }
}
