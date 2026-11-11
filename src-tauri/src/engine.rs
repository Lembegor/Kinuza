//! Torrent engine: a thin layer over a librqbit session that speaks in info hashes and plain DTOs.

use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use librqbit::{
    api::TorrentIdOrHash, dht::Id20, AddTorrent, AddTorrentOptions, AddTorrentResponse,
    ListenerOptions, ManagedTorrent, Session, SessionOptions, SessionPersistenceConfig,
    TorrentStatsState,
};
use serde::{Deserialize, Serialize};

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

/// A torrent that is only watched online, between viewings: its data is gone from disk and it
/// is out of the session, but it can be brought back from the saved .torrent the moment it is played.
#[derive(Serialize, Deserialize, Clone)]
struct ParkedTorrent {
    name: String,
    files: Vec<ParkedFile>,
    /// Peers it was exchanging data with and its trackers when parked. Without them the next
    /// viewing would have to find the swarm from scratch, which can take minutes.
    #[serde(default)]
    peers: Vec<SocketAddr>,
    #[serde(default)]
    trackers: Vec<String>,
}

/// Peers remembered for a parked torrent; more than enough to get going again.
const MAX_REMEMBERED_PEERS: usize = 200;

#[derive(Serialize, Deserialize, Clone)]
struct ParkedFile {
    path: String,
    length: u64,
}

const PARKED_INDEX_NAME: &str = "parked.json";
/// When each torrent watched online was last played, by info hash; the oldest leave the cache first.
const CACHE_INDEX_NAME: &str = "cache.json";
/// After the player lets go of a torrent it stays connected to its peers this long: coming back
/// to the film (another episode, a wrong click) then continues at full speed at once.
const ONLINE_LINGER: Duration = Duration::from_secs(5 * 60);
/// What was fetched for an online viewing is kept at most this long since it was last played.
const CACHE_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// The cache is measured and trimmed every this many policy checks.
const CACHE_CHECK_EVERY: u32 = 6;
const BYTES_PER_GIBIBYTE: f64 = 1024.0 * 1024.0 * 1024.0;
const CACHE_DATA_FOLDER_NAME: &str = "data";
/// State reported for a parked torrent.
const STATE_PARKED: &str = "parked";
/// State reported for a torrent waiting for its turn to download.
const STATE_QUEUED: &str = "queued";
/// How long after start-up leftovers of an interrupted online viewing are cleaned.
const STARTUP_CLEANUP_DELAY: Duration = Duration::from_secs(8);

/// How downloads share the connection and the disk; set from the app's settings.
#[derive(Deserialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPolicy {
    /// Bytes per second for all torrents together; 0 means no limit.
    pub download_limit: u32,
    pub upload_limit: u32,
    /// Torrents downloading at once; the rest wait their turn. 0 means all at once.
    pub max_active_downloads: usize,
    /// Seeding stops once a torrent has given back this share of its size (1.0 is "as much as it took"); 0 means never.
    pub seed_ratio: f32,
    /// Disk space what was watched online may keep, in GiB; 0 keeps nothing once a viewing ends.
    #[serde(default)]
    pub cache_limit_gb: f32,
}

const POLICY_CHECK_INTERVAL: Duration = Duration::from_secs(5);
/// How long a reader waits for a freshly added torrent to become readable.
const STREAM_READY_TIMEOUT: Duration = Duration::from_secs(60);

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
    /// Where torrents that are only watched online keep what they fetch; emptied after each viewing.
    cache_dir: PathBuf,
    parked: Mutex<HashMap<String, ParkedTorrent>>,
    /// Online torrents played since start-up; the start-up cleanup leaves these alone.
    played: Mutex<HashSet<String>>,
    /// Serialises parking a torrent and bringing it back.
    parking: tokio::sync::Mutex<()>,
    policy: Mutex<DownloadPolicy>,
    /// Torrents paused by the queue rather than by the user; they resume when a place frees up.
    queued: Mutex<HashSet<String>>,
    /// Torrents whose seeding the ratio limit has already stopped once; resumed by hand, they stay on.
    seeding_stopped: Mutex<HashSet<String>>,
    /// Online torrents the player let go of, and when; they stay connected for `ONLINE_LINGER`.
    released: Mutex<HashMap<String, Instant>>,
    /// When each online torrent was last played, in Unix milliseconds; kept in `CACHE_INDEX_NAME`.
    last_played: Mutex<HashMap<String, u64>>,
    /// Whether the settings have said how large the cache may be. Until then nothing is trimmed.
    policy_known: std::sync::atomic::AtomicBool,
}

impl Engine {
    pub async fn start(default_output: PathBuf, persistence_dir: PathBuf, cache_dir: PathBuf) -> Result<Arc<Self>> {
        std::fs::create_dir_all(&default_output).ok();
        std::fs::create_dir_all(&persistence_dir).ok();
        std::fs::create_dir_all(&cache_dir).ok();

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

        let parked = std::fs::read_to_string(cache_dir.join(PARKED_INDEX_NAME))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let last_played = std::fs::read_to_string(cache_dir.join(CACHE_INDEX_NAME))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let engine = Arc::new(Self {
            session,
            pending: Mutex::new(HashMap::new()),
            cache_dir,
            parked: Mutex::new(parked),
            played: Mutex::new(HashSet::new()),
            parking: tokio::sync::Mutex::new(()),
            policy: Mutex::new(DownloadPolicy::default()),
            queued: Mutex::new(HashSet::new()),
            seeding_stopped: Mutex::new(HashSet::new()),
            released: Mutex::new(HashMap::new()),
            last_played: Mutex::new(last_played),
            policy_known: std::sync::atomic::AtomicBool::new(false),
        });

        let keeper = engine.clone();
        tokio::spawn(async move {
            let mut tick: u32 = 0;
            loop {
                tokio::time::sleep(POLICY_CHECK_INTERVAL).await;
                keeper.enforce_policy().await;
                keeper.rest_released().await;
                tick = tick.wrapping_add(1);
                if tick % CACHE_CHECK_EVERY == 0 {
                    keeper.trim_cache().await;
                }
            }
        });

        // A viewing cut short (the app closed or crashed mid-film) leaves its torrent running.
        let cleaner = engine.clone();
        tokio::spawn(async move {
            tokio::time::sleep(STARTUP_CLEANUP_DELAY).await;
            cleaner.rest_leftovers().await;
        });
        Ok(engine)
    }

    pub fn set_policy(&self, policy: DownloadPolicy) {
        let limit = |bytes_per_second: u32| std::num::NonZeroU32::new(bytes_per_second);
        self.session.ratelimits.set_download_bps(limit(policy.download_limit));
        self.session.ratelimits.set_upload_bps(limit(policy.upload_limit));
        *self.policy.lock().unwrap() = policy;
        self.policy_known.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// Keeps the number of simultaneous downloads within the limit and stops seeding at the ratio limit.
    async fn enforce_policy(&self) {
        let policy = *self.policy.lock().unwrap();
        // Torrents watched online are not downloads and are left out.
        let torrents: Vec<TorrentHandle> = self.session.with_torrents(|torrents| {
            torrents.map(|(_, handle)| handle.clone()).filter(|handle| !self.is_online_only(handle)).collect()
        });

        if policy.seed_ratio > 0.0 {
            for handle in &torrents {
                let stats = handle.stats();
                let info_hash = handle.info_hash().as_string();
                let given_back = stats.total_bytes > 0 && stats.uploaded_bytes as f64 >= stats.total_bytes as f64 * f64::from(policy.seed_ratio);
                if stats.finished && given_back && !handle.is_paused() && self.seeding_stopped.lock().unwrap().insert(info_hash) {
                    let _ = self.session.pause(handle).await;
                }
            }
        }

        let downloading: Vec<&TorrentHandle> = torrents
            .iter()
            .filter(|handle| {
                let stats = handle.stats();
                !stats.finished && stats.total_bytes > 0
            })
            .collect();
        // A queued torrent the user resumed by hand is no longer the queue's to manage.
        self.queued.lock().unwrap().retain(|info_hash| {
            downloading.iter().any(|handle| &handle.info_hash().as_string() == info_hash && handle.is_paused())
        });

        let limit = if policy.max_active_downloads == 0 { usize::MAX } else { policy.max_active_downloads };
        let mut active = downloading.iter().filter(|handle| !handle.is_paused()).count();
        for handle in downloading.iter().rev() {
            if active <= limit {
                break;
            }
            if !handle.is_paused() && self.session.pause(handle).await.is_ok() {
                self.queued.lock().unwrap().insert(handle.info_hash().as_string());
                active -= 1;
            }
        }
        for handle in &downloading {
            if active >= limit {
                break;
            }
            let info_hash = handle.info_hash().as_string();
            if self.queued.lock().unwrap().contains(&info_hash) && self.session.unpause(handle).await.is_ok() {
                self.queued.lock().unwrap().remove(&info_hash);
                active += 1;
            }
        }
    }

    fn cache_data_folder(&self, info_hash: &str) -> PathBuf {
        self.cache_dir.join(CACHE_DATA_FOLDER_NAME).join(info_hash)
    }

    fn torrent_file(&self, info_hash: &str) -> PathBuf {
        self.cache_dir.join(format!("{info_hash}.torrent"))
    }

    /// Only watched online: nothing of it is kept once the viewing ends.
    fn is_online_only(&self, handle: &TorrentHandle) -> bool {
        handle.output_folder().starts_with(&self.cache_dir)
    }

    fn save_parked(&self) {
        let parked = self.parked.lock().unwrap();
        if let Ok(text) = serde_json::to_string(&*parked) {
            let _ = std::fs::write(self.cache_dir.join(PARKED_INDEX_NAME), text);
        }
    }

    fn forget_parked(&self, info_hash: &str) {
        self.parked.lock().unwrap().remove(info_hash);
        let _ = std::fs::remove_file(self.torrent_file(info_hash));
        self.save_parked();
    }

    /// Takes an online-only torrent out of the session and deletes what it fetched, keeping its
    /// .torrent so that it can be added again elsewhere (as a download).
    async fn park(&self, handle: &TorrentHandle) -> Result<()> {
        let info_hash = handle.info_hash().as_string();
        let torrent_bytes = handle.with_metadata(|metadata| metadata.torrent_bytes.clone())?;
        std::fs::write(self.torrent_file(&info_hash), &torrent_bytes)?;
        let files = file_views(handle, &[])
            .into_iter()
            .map(|file| ParkedFile { path: file.path, length: file.length })
            .collect();
        // The peer list type is not exported by librqbit; its filter and its keys go through serde.
        let peers = handle
            .live()
            .and_then(|live| {
                let filter = serde_json::from_value(serde_json::json!({ "state": "live" })).ok()?;
                Some(live.per_peer_stats_snapshot(filter).peers.into_keys().collect::<Vec<String>>())
            })
            .unwrap_or_default()
            .iter()
            .filter_map(|address| address.parse().ok())
            .take(MAX_REMEMBERED_PEERS)
            .collect();
        let trackers = handle.shared().trackers.iter().map(|tracker| tracker.to_string()).collect();
        self.parked
            .lock()
            .unwrap()
            .insert(info_hash.clone(), ParkedTorrent { name: display_name(handle), files, peers, trackers });
        self.save_parked();

        self.forget_cached(&info_hash);
        self.session.delete(TorrentIdOrHash::Hash(handle.info_hash()), true).await?;
        let _ = std::fs::remove_dir_all(self.cache_data_folder(&info_hash));
        Ok(())
    }

    fn save_last_played(&self) {
        let last_played = self.last_played.lock().unwrap();
        if let Ok(text) = serde_json::to_string(&*last_played) {
            let _ = std::fs::write(self.cache_dir.join(CACHE_INDEX_NAME), text);
        }
    }

    fn touch(&self, info_hash: &str) {
        self.last_played.lock().unwrap().insert(info_hash.to_owned(), unix_millis(SystemTime::now()));
        self.save_last_played();
    }

    fn forget_cached(&self, info_hash: &str) {
        self.released.lock().unwrap().remove(info_hash);
        if self.last_played.lock().unwrap().remove(info_hash).is_some() {
            self.save_last_played();
        }
    }

    /// Being played now, or let go of a moment ago and still connected.
    fn is_in_use(&self, info_hash: &str) -> bool {
        self.played.lock().unwrap().contains(info_hash) || self.released.lock().unwrap().contains_key(info_hash)
    }

    /// Online torrents of the session that nothing is playing: these are the cache. With
    /// `with_lingering`, also the ones let go of a moment ago and still connected.
    fn resting_online(&self, with_lingering: bool) -> Vec<TorrentHandle> {
        self.session.with_torrents(|torrents| {
            torrents
                .map(|(_, handle)| handle.clone())
                .filter(|handle| {
                    let info_hash = handle.info_hash().as_string();
                    let busy = if with_lingering { self.played.lock().unwrap().contains(&info_hash) } else { self.is_in_use(&info_hash) };
                    self.is_online_only(handle) && !busy
                })
                .collect()
        })
    }

    /// Pauses a resting online torrent: it stops talking to the swarm and keeps what it fetched.
    async fn rest(&self, handle: &TorrentHandle) {
        if !handle.is_paused() {
            if let Err(error) = self.session.pause(handle).await {
                eprintln!("engine: could not pause {}: {error}", handle.info_hash().as_string());
            }
        }
    }

    /// Online torrents left running by a viewing the app did not see end.
    async fn rest_leftovers(&self) {
        let _parking = self.parking.lock().await;
        for handle in self.resting_online(false) {
            self.rest(&handle).await;
        }
    }

    /// Pauses the online torrents whose time to stay connected after a viewing has run out.
    async fn rest_released(&self) {
        let _parking = self.parking.lock().await;
        let due: Vec<String> = {
            let mut released = self.released.lock().unwrap();
            let due: Vec<String> =
                released.iter().filter(|(_, since)| since.elapsed() >= ONLINE_LINGER).map(|(hash, _)| hash.clone()).collect();
            for hash in &due {
                released.remove(hash);
            }
            due
        };
        for info_hash in due {
            if let Ok(handle) = self.find(&info_hash) {
                if self.is_online_only(&handle) && !self.played.lock().unwrap().contains(&info_hash) {
                    self.rest(&handle).await;
                }
            }
        }
    }

    /// Removes the cached torrents unplayed for too long, then the least recently played ones
    /// until the cache fits its limit. Returns the bytes freed.
    async fn trim_cache(&self) -> u64 {
        if !self.policy_known.load(std::sync::atomic::Ordering::Relaxed) {
            return 0;
        }
        let limit = (f64::from(self.policy.lock().unwrap().cache_limit_gb.max(0.0)) * BYTES_PER_GIBIBYTE) as u64;
        self.evict_cache(limit, false).await
    }

    /// Everything watched online that nothing is playing, dropped from the disk. Returns the bytes freed.
    pub async fn clear_cache(&self) -> u64 {
        self.evict_cache(0, true).await
    }

    /// `with_lingering`: the torrents still connected after a viewing may go too (the user asked
    /// for the cache to be emptied); otherwise they are left for the viewer to come back to.
    async fn evict_cache(&self, limit: u64, with_lingering: bool) -> u64 {
        let _parking = self.parking.lock().await;
        let now = unix_millis(SystemTime::now());
        let max_age = CACHE_MAX_AGE.as_millis() as u64;
        let mut resting: Vec<(TorrentHandle, u64, u64)> = self
            .resting_online(with_lingering)
            .into_iter()
            .map(|handle| {
                let info_hash = handle.info_hash().as_string();
                let played = self.last_played.lock().unwrap().get(&info_hash).copied().unwrap_or(0);
                let size = allocated_bytes(&self.cache_data_folder(&info_hash));
                (handle, played, size)
            })
            .collect();
        // What is being watched counts towards the limit too, but is never the one to go.
        let in_use: u64 = self
            .session
            .with_torrents(|torrents| {
                torrents
                    .map(|(_, handle)| handle.clone())
                    .filter(|handle| {
                        let info_hash = handle.info_hash().as_string();
                        let busy = if with_lingering { self.played.lock().unwrap().contains(&info_hash) } else { self.is_in_use(&info_hash) };
                        self.is_online_only(handle) && busy
                    })
                    .collect::<Vec<_>>()
            })
            .iter()
            .map(|handle| allocated_bytes(&self.cache_data_folder(&handle.info_hash().as_string())))
            .sum();
        resting.sort_by_key(|(_, played, _)| *played);
        let mut total = in_use + resting.iter().map(|(_, _, size)| size).sum::<u64>();
        let mut freed = 0;
        for (handle, played, size) in resting {
            let too_old = now.saturating_sub(played) > max_age;
            if !too_old && total <= limit {
                continue;
            }
            let info_hash = handle.info_hash().as_string();
            match self.session.delete(TorrentIdOrHash::Hash(handle.info_hash()), true).await {
                Ok(()) => {
                    let _ = std::fs::remove_dir_all(self.cache_data_folder(&info_hash));
                    self.forget_cached(&info_hash);
                    total = total.saturating_sub(size);
                    freed += size;
                }
                Err(error) => eprintln!("engine: could not drop {info_hash} from the cache: {error}"),
            }
        }
        freed
    }

    /// Disk space taken by what was watched online.
    pub fn cache_bytes(&self) -> u64 {
        allocated_bytes(&self.cache_dir.join(CACHE_DATA_FOLDER_NAME))
    }

    /// Adds a torrent from its .torrent contents. With no files it goes to the online cache.
    async fn add_from_bytes(
        &self,
        info_hash: &str,
        torrent_bytes: Bytes,
        name: &str,
        file_count: usize,
        files: Vec<usize>,
        download_dir: &Path,
        peers: Vec<SocketAddr>,
        trackers: Vec<String>,
    ) -> Result<()> {
        let output_folder = if files.is_empty() {
            self.cache_data_folder(info_hash)
        } else if file_count > 1 {
            download_dir.join(sanitize_folder_name(name))
        } else {
            download_dir.to_path_buf()
        };
        let options = AddTorrentOptions {
            only_files: Some(files),
            overwrite: true,
            output_folder: Some(output_folder.to_string_lossy().into_owned()),
            initial_peers: Some(peers),
            trackers: Some(trackers),
            ..Default::default()
        };
        self.session.add_torrent(AddTorrent::from_bytes(torrent_bytes), Some(options)).await?;
        Ok(())
    }

    /// The saved .torrent of a parked torrent, with what is known about it.
    fn parked_torrent(&self, info_hash: &str) -> Option<(Bytes, ParkedTorrent)> {
        let parked = self.parked.lock().unwrap().get(info_hash).cloned()?;
        let bytes = std::fs::read(self.torrent_file(info_hash)).ok()?;
        Some((Bytes::from(bytes), parked))
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

    /// Adds a previously inspected torrent and starts downloading the given files.
    /// With no files the torrent is only watched online: data is fetched as the player asks for
    /// it, kept apart from the downloads and deleted when the viewing ends.
    pub async fn add(&self, info_hash: &str, files: Vec<usize>, download_dir: &Path) -> Result<()> {
        let known = self.find(info_hash).is_ok() || self.parked.lock().unwrap().contains_key(info_hash);
        if known {
            self.pending.lock().unwrap().remove(info_hash);
            if files.is_empty() {
                return Ok(());
            }
            return self.select_files(info_hash, &files, download_dir).await;
        }

        let pending = self
            .pending
            .lock()
            .unwrap()
            .remove(info_hash)
            .ok_or_else(|| anyhow!("torrent_not_inspected"))?;
        self.add_from_bytes(
            info_hash,
            pending.torrent_bytes,
            &pending.name,
            pending.file_count,
            files,
            download_dir,
            pending.seen_peers,
            Vec::new(),
        )
        .await
    }

    /// Torrents in the session, then the ones parked between online viewings.
    pub fn list(&self) -> Vec<TorrentView> {
        let mut list: Vec<TorrentView> = self.session.with_torrents(|torrents| {
            torrents
                .map(|(_, handle)| {
                    let mut view = torrent_view(handle);
                    // Between viewings an online torrent is part of the cache, not a download.
                    let played = self.played.lock().unwrap().contains(&view.info_hash);
                    if self.is_online_only(handle) && !played {
                        view.state = STATE_PARKED;
                    }
                    view
                })
                .collect()
        });
        {
            let queued = self.queued.lock().unwrap();
            for torrent in &mut list {
                if torrent.state == "paused" && queued.contains(&torrent.info_hash) {
                    torrent.state = STATE_QUEUED;
                }
            }
        }
        for (info_hash, parked) in self.parked.lock().unwrap().iter() {
            if list.iter().any(|torrent| &torrent.info_hash == info_hash) {
                continue;
            }
            list.push(TorrentView {
                info_hash: info_hash.clone(),
                name: parked.name.clone(),
                output_folder: String::new(),
                state: STATE_PARKED,
                error: None,
                progress_bytes: 0,
                total_bytes: 0,
                uploaded_bytes: 0,
                finished: false,
                download_speed: 0.0,
                upload_speed: 0.0,
                peers: 0,
                files: parked
                    .files
                    .iter()
                    .enumerate()
                    .map(|(index, file)| TorrentFileView {
                        index,
                        path: file.path.clone(),
                        length: file.length,
                        included: false,
                        downloaded: 0,
                    })
                    .collect(),
            });
        }
        list
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
        let _parking = self.parking.lock().await;
        self.forget_parked(info_hash);
        self.forget_cached(info_hash);
        let Ok(handle) = self.find(info_hash) else {
            return Ok(());
        };
        // What an online-only torrent fetched is never worth keeping.
        let online_only = self.is_online_only(&handle);
        self.session.delete(TorrentIdOrHash::Hash(handle.info_hash()), delete_files || online_only).await?;
        if online_only {
            let _ = std::fs::remove_dir_all(self.cache_data_folder(info_hash));
        }
        Ok(())
    }

    /// Starts saving the given files to `download_dir` (never stops saving any). A torrent that
    /// was only watched online moves out of the cache and becomes an ordinary download.
    pub async fn select_files(&self, info_hash: &str, files: &[usize], download_dir: &Path) -> Result<()> {
        let _parking = self.parking.lock().await;
        if let Ok(handle) = self.find(info_hash) {
            if !self.is_online_only(&handle) {
                self.include_files(&handle, files).await?;
                return self.resume_handle(&handle).await;
            }
            // The cache is not where downloads live: start over in the download folder.
            self.park(&handle).await?;
        }
        let (torrent_bytes, parked) = self.parked_torrent(info_hash).ok_or_else(|| anyhow!("torrent_not_found"))?;
        self.forget_parked(info_hash);
        self.add_from_bytes(
            info_hash,
            torrent_bytes,
            &parked.name,
            parked.files.len(),
            files.to_vec(),
            download_dir,
            parked.peers,
            parked.trackers,
        )
        .await
    }

    /// Returns the torrent, running and ready for `stream`. The file does not have to be selected
    /// for download: a stream fetches the pieces it reads, and only those. A torrent parked after
    /// an online viewing is brought back first.
    pub async fn prepare_stream(&self, info_hash: &str) -> Result<TorrentHandle> {
        let _parking = self.parking.lock().await;
        if self.find(info_hash).is_err() {
            let (torrent_bytes, parked) = self.parked_torrent(info_hash).ok_or_else(|| anyhow!("torrent_not_found"))?;
            self.add_from_bytes(
                info_hash,
                torrent_bytes,
                &parked.name,
                parked.files.len(),
                Vec::new(),
                Path::new(""),
                parked.peers,
                parked.trackers,
            )
            .await?;
        }
        let handle = self.find(info_hash)?;
        if self.is_online_only(&handle) {
            self.played.lock().unwrap().insert(info_hash.to_owned());
            self.released.lock().unwrap().remove(info_hash);
            self.touch(info_hash);
        }
        self.resume_handle(&handle).await?;
        // A torrent added a moment ago is still checking its files and cannot be read yet.
        tokio::time::timeout(STREAM_READY_TIMEOUT, handle.wait_until_initialized())
            .await
            .map_err(|_| anyhow!("torrent_not_ready"))??;
        Ok(handle)
    }

    /// Ends an online viewing. The torrent stays connected for `ONLINE_LINGER`, then pauses and
    /// keeps what it fetched, so that the film opens at once where it was left. The cache limit
    /// decides how long that data stays. Does nothing for a torrent that is being downloaded.
    pub async fn release_online(&self, info_hash: &str) -> Result<()> {
        let _parking = self.parking.lock().await;
        self.played.lock().unwrap().remove(info_hash);
        if let Ok(handle) = self.find(info_hash) {
            if self.is_online_only(&handle) {
                self.touch(info_hash);
                self.released.lock().unwrap().insert(info_hash.to_owned(), Instant::now());
            }
        }
        Ok(())
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

fn unix_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

/// Disk space files under `path` really take. Torrent files are sparse: a film watched for ten
/// minutes is as long as the whole film but holds only those ten minutes.
fn allocated_bytes(path: &Path) -> u64 {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if metadata.is_dir() {
        return std::fs::read_dir(path)
            .map(|entries| entries.flatten().map(|entry| allocated_bytes(&entry.path())).sum())
            .unwrap_or(0);
    }
    file_allocated_bytes(path).unwrap_or(metadata.len())
}

#[cfg(windows)]
fn file_allocated_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetCompressedFileSizeW, INVALID_FILE_SIZE};

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut high = 0u32;
    // SAFETY: `wide` is a NUL-terminated path and `high` outlives the call.
    let low = unsafe { GetCompressedFileSizeW(wide.as_ptr(), &mut high) };
    // A size whose low half is all ones is ambiguous with the error value; the plain length will do.
    if low == INVALID_FILE_SIZE {
        return None;
    }
    Some((u64::from(high) << 32) | u64::from(low))
}

#[cfg(not(windows))]
fn file_allocated_bytes(_path: &Path) -> Option<u64> {
    None
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
